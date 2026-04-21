// NOTICE:
// We import the non-bundled `wlipsync/wlipsync.js` variant (not the default
// `wlipsync` single-file export). Reason: the single variant inlines the
// AudioWorklet as a `data:` URL via `new URL("data:…", import.meta.url)` and
// also uses top-level await for its WASM bootstrap. Vite's dev bundler
// rejects the top-level await against its default ES2020 target, and
// even when we bump to ES2022 some Chromium builds refuse to load a
// `data:` URL via `audioWorklet.addModule(…)` (CSP / origin mismatch),
// which surfaces as a generic "Unable to load a worklet's module" error.
// Root cause: wlipsync's bundled variant embeds worklet + WASM inline.
// Source: node_modules/wlipsync/dist/wlipsync-single.js:1.
// Fix: use the non-bundled variant and serve audio-processor.js + wlipsync.wasm
// from /public/wlipsync/ so they load as same-origin static assets.
import {
  createWLipSyncNode,
  configuration as wlipsyncConfig,
  type Profile,
  type WLipSyncAudioNode,
} from 'wlipsync/wlipsync.js'
import type { VRM } from '@pixiv/three-vrm'
import { getAudioContext, resumeAudioContext } from '../audio/context'

// ---------------------------------------------------------------------------
// Phoneme → VRM blendshape mapping
// ---------------------------------------------------------------------------
//
// wlipsync outputs weights keyed by the profile's MFCC class names (A/E/I/O/U/S).
// VRM's expression manager uses Japanese-vowel blendshape names (aa/ih/ou/ee/oh).
// Map wlipsync's Latin-vowel naming onto the VRM preset names:
//
//   A (as in 'a-h') → aa
//   E (as in 'eh')  → ee
//   I (as in 'ee')  → ih     (Japanese 'ih' is English 'ee')
//   O (as in 'oh')  → oh
//   U (as in 'oo')  → ou
//   S (silence)     → not mapped; it's noise we ignore
//
// These five blendshapes are REQUIRED by the VRM 0.x/1.x spec, so any
// well-authored avatar has them.
const LIP_KEYS = ['A', 'E', 'I', 'O', 'U'] as const
type LipKey = (typeof LIP_KEYS)[number]

const BLENDSHAPE: Record<LipKey, string> = {
  A: 'aa',
  E: 'ee',
  I: 'ih',
  O: 'oh',
  U: 'ou',
}

// ATTACK rises the mouth shape fast (audio just arrived, mouth should snap
// open); RELEASE falls slower (mouth doesn't instantly snap shut after a
// syllable, it decays). Units: 1/seconds — higher = faster response.
const ATTACK = 50
const RELEASE = 30

// Final weight is scaled down a touch so the mouth doesn't "yell" on loud
// syllables; matches AIRI's tuned 0.7 factor.
const WEIGHT_SCALE = 0.7

// ---------------------------------------------------------------------------
// Singleton driver
// ---------------------------------------------------------------------------

export interface LipSyncDriver {
  node: WLipSyncAudioNode
  connectSource(source: AudioNode): void
  disconnectSource(source: AudioNode): void
  update(vrm: VRM, delta: number): void
  dispose(): void
}

let driverPromise: Promise<LipSyncDriver> | null = null
let driver: LipSyncDriver | null = null

/**
 * Lazy-initializes the lip-sync pipeline. Must be called from a user gesture
 * (it resumes the AudioContext).
 */
export async function ensureLipSyncDriver(profileUrl = '/lipsync/profile.json'): Promise<LipSyncDriver> {
  if (driver) return driver
  if (driverPromise) return driverPromise

  driverPromise = (async () => {
    const ctx = await resumeAudioContext()

    // One-time: compile WASM (main thread) + register AudioWorklet module.
    // Both assets live in /public/wlipsync/ (copied from the npm package's
    // dist/ at bootstrap) so they're served same-origin by Vite.
    if (!wlipsyncConfig.wasmModule) {
      wlipsyncConfig.wasmModule = await WebAssembly.compileStreaming(
        fetch('/wlipsync/wlipsync.wasm'),
      )
    }
    await ctx.audioWorklet.addModule('/wlipsync/audio-processor.js')

    const profile = (await (await fetch(profileUrl)).json()) as Profile
    const node = await createWLipSyncNode(ctx, profile)

    const smoothed: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 }

    const d: LipSyncDriver = {
      node,
      connectSource(source) {
        source.connect(node)
      },
      disconnectSource(source) {
        try { source.disconnect(node) } catch { /* already disconnected */ }
      },
      update(vrm, delta) {
        if (!vrm.expressionManager) return

        // Raw wlipsync outputs:
        //   node.volume   — 0..1 overall loudness
        //   node.weights  — { A, E, I, O, U, S } 0..1 phoneme confidences
        const vol = node.volume ?? 0
        // Amplitude shaping: compress quiet sounds (power < 1 pulls mids up,
        // keeps peaks at 1) and cap at 1. Matches AIRI's 0.9 * pow 0.7.
        const amp = Math.min(vol * 0.9, 1) ** 0.7
        const raw = node.weights

        // Projected target = raw weight * amplitude envelope.
        const target: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 }
        for (const k of LIP_KEYS) {
          target[k] = Math.max(0, (raw[k] ?? 0) * amp)
        }

        // Asymmetric smoothing: ATTACK when rising, RELEASE when falling.
        for (const k of LIP_KEYS) {
          const from = smoothed[k]
          const to = target[k]
          const rateHz = to > from ? ATTACK : RELEASE
          const t = 1 - Math.exp(-rateHz * delta)
          smoothed[k] = from + (to - from) * t

          // Dead-zone to avoid jittery near-zero values.
          const w = smoothed[k] <= 0.01 ? 0 : smoothed[k] * WEIGHT_SCALE
          vrm.expressionManager.setValue(BLENDSHAPE[k], w)
        }
      },
      dispose() {
        node.disconnect()
      },
    }

    driver = d
    return d
  })()

  return driverPromise
}

export function getLipSyncDriver(): LipSyncDriver | null {
  return driver
}

/**
 * Creates a playback source wired to both the speakers AND the lip-sync
 * analyzer. Returns the source — caller owns `.start()` and cleanup.
 *
 * Use when:
 * - Playing a decoded AudioBuffer (from TTS or a debug file upload) while
 *   the character's mouth must track the audio
 */
export function createPlaybackSource(
  buffer: AudioBuffer,
  driver: LipSyncDriver,
): AudioBufferSourceNode {
  const ctx = getAudioContext()
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  driver.connectSource(src)
  return src
}
