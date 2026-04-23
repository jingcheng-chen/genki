# AI Companion — Project Guide for Future Claude Sessions

A 3D AI companion in the browser. VRM avatar + voice chat + memory. Single-user, local-first state, cloud LLM/TTS/STT.

This file is durable context for any agent working in this repo. Read it once per session.

## Stack snapshot

- **Client**: React 19 + Vite 8 + TypeScript 6 + Tailwind v4. State via Zustand 5 (with `persist` for character + memory).
- **3D**: `three@0.184`, `@react-three/fiber@9`, `@react-three/drei@10`, `@pixiv/three-vrm@4`, `@pixiv/three-vrm-animation`.
- **Voice**: wlipsync (audioworklet + WASM) for lip-sync, `@ricky0123/vad-web` for VAD, ElevenLabs `speechToText.convert` (Scribe) + `textToSpeech.convert` (Flash v2.5).
- **LLM**: xAI Grok via direct SDK (regional endpoint — see §LLM provider below). Vercel `ai@6` SDK for streaming + structured output.
- **Server**: Hono on :8787, Vite on :5173, `/api/*` proxied by Vite dev server. `@hono/node-server`, `tsx watch`.
- **Persistence**: `idb-keyval` for memory (IndexedDB, per-character markdown files), localStorage via Zustand `persist` for character + custom instructions.
- **Tests**: Vitest 4, `fake-indexeddb` for repo tests.

## What the user already decided (do not re-litigate)

- Model: **`grok-4-1-fast-non-reasoning`** via direct xAI SDK, regional `eu-west-1.api.x.ai/v1`. OpenRouter added a ~4s US-endpoint latency floor we escaped by going direct. `XAI_API_KEY` (server-only).
- Voice: Rachel (`21m00Tcm4TlvDq8ikWAM`) for Mika, Charlotte (`XB0fDUnXU5powFXDhCwa`) for Ani. Bundled per preset in `src/vrm/presets.ts`.
- Characters: Mika + Ani, bundled VRM presets only. **No uploads, no edits, no voice customization, no delete.** Only per-character custom-instructions textarea (appended to persona in `buildSystemPrompt`).
- Memory: per-character markdown files in IndexedDB, human-curve decay with fact extraction + compaction. Same model for conversation and memory curation. `tagAudioEvents: false` on Scribe (clean transcripts).
- Languages: en-US + zh-CN (i18n deferred to later phase).
- Web-only, no Electron, no mobile.

## Phase state (ledger)

0-11 done.

1. VRM + idle loop + blinks + saccades
2. wlipsync hookup (non-bundled variant, same-origin assets)
3. ElevenLabs TTS streaming
4. LLM chat + marker protocol (`<|ACT:…|>` / `<|PLAY:id|>` / `<|DELAY:N|>`)
5. Mic + VAD + STT + barge-in (500ms grace window)
6. Character system (2 presets, persist, picker)
7. Memory system (decay + extractor + compactor + retriever + inspector)
8. Observability (tracer ring buffer + `Shift+D` debug panel with 5 tabs)
9. **Skipped (i18n)** — deferred
10. Cold-start polish (StartGate, scene store, toasts, shortcuts modal)
11. Latency — direct `@ai-sdk/xai` with `baseURL: https://eu-west-1.api.x.ai/v1`. Dropped LLM first-token from ~4s (OpenRouter US) to **~600ms p50**, first-audio ~1.3s p50. Personas compressed ~50%, marker-examples block kept in the stable prefix, system prompt block order locked.

Deferred/explicit future work:
- Phase 7.1: "forget this" undo window + markdown export/import UI.
- Phase 9: i18n (en-US + zh-CN locale files + language picker).

## File map (the stuff you'll touch)

```
server/
├── index.ts                         Hono bootstrap + route registration
├── lib/
│   ├── llm.ts                       chatModel() factory (xAI + eu-west-1)
│   ├── tts.ts                       ElevenLabs client (HAND-FORMATTED, has semicolons, DO NOT reformat)
│   ├── stt.ts                       Scribe client (shares TTS singleton)
│   └── memory.ts                    Zod schemas + extractor/compactor prompts
└── routes/
    ├── chat.ts                      POST /api/chat — streamText
    ├── tts.ts                       POST /api/tts
    ├── stt.ts                       POST /api/stt (pcm_s16le_16 fast-path)
    └── memory.ts                    POST /api/memory/{extract,compact}

src/
├── App.tsx                          <Scene /> + <CharacterPicker /> + <ChatPanel /> + <StartGate /> + <Toasts /> + <ShortcutsModal /> + DEV <DebugPanel />
├── main.tsx                         NO <StrictMode>. See §gotchas.
├── vite-env.d.ts
├── index.css
├── adapters/
│   ├── llm.ts                       fetch('/api/chat') + SSE-ish text-stream reader; emits llm.* trace events
│   ├── tts.ts                       POST /api/tts → decodeAudioData
│   └── stt.ts                       FormData POST /api/stt
├── audio/
│   ├── context.ts                   getAudioContext() / resumeAudioContext()
│   ├── vad.ts                       MicVAD wrapper, same-origin /vad /ort assets
│   └── wav-encoder.ts               Float32 → 16-bit PCM WAV
├── pipelines/
│   ├── turn-controller.ts           State machine: idle/listening/transcribing/thinking/speaking. Owns VAD, history, TurnHandle. fireBargeIn + 500ms grace.
│   ├── turn.ts                      runTurn(): LLM → categorizer → marker-parser → speaker + expression/animation
│   ├── response-categorizer.ts      Strips <think>/<thinking>/<reasoning>/<thought> tags
│   ├── marker-parser.ts             Stream-splits <|…|> special + literal text (TAIL_HOLD=2)
│   ├── tts-chunker.ts               Sentence chunker with "boost mode" (first 2 chunks ≤ 6 words)
│   └── speech-pipeline.ts           createStreamingSpeaker (queue + serialize playback), tracedSanitize (strip HTML/emoji/punct-only, returns null on empty)
├── vrm/
│   ├── Scene.tsx                    <Canvas> + <VRMCharacter key={preset.id} />
│   ├── VRMCharacter.tsx             Loads VRM + animations, wires blink/saccade/anim/expression/lip-sync, FPS sampler
│   ├── presets.ts                   Mika + Ani (persona + voiceId + animations + tagline)
│   ├── animation-controller.ts      AnimationMixer, idle as base layer, crossFadeFrom for overlays
│   ├── expression-controller.ts     ADSR facial expression envelopes (emotion → blendshape)
│   ├── lip-sync-driver.ts           wlipsync AudioWorklet (non-bundled variant, /wlipsync/ assets)
│   └── idle-life.ts                 Blink + saccade controllers
├── memory/
│   ├── types.ts                     MemoryFact + CATEGORY_BASE_STABILITY + COMPRESSION_TARGET_WORDS
│   ├── decay.ts                     computeStability, retentionScore, rankFacts
│   ├── format.ts                    markdown serde (parseMemoryMarkdown / stringifyMemoryMarkdown)
│   ├── repo.ts                      idb-keyval ops, serialized write mutex per character, DEV __dbg_memory hook
│   ├── retriever.ts                 buildMemoryBlock() — top-K=5 episodic + all durable/pref/relational + all L2/L3
│   ├── extractor.ts                 Queue-of-one, POST /api/memory/extract, dedupe (Jaccard ≥ 0.85 or substring), apply insert/reinforce/outdate
│   └── compactor.ts                 requestIdleCallback + 25-turn counter, POST /api/memory/compact, bump compressionLevel
├── observability/
│   ├── types.ts                     TraceEvent union, TraceCategory constants
│   ├── tracer.ts                    Module singleton ring buffer (1000), no-op in production (DEV gate)
│   ├── metrics.ts                   computeTurnStages, percentiles, recentTurns
│   └── fps.ts                       createFpsSampler (1Hz in useFrame)
├── stores/
│   ├── character.ts                 activePresetId + customInstructions (Zustand persist, hasHydrated flag)
│   ├── scene.ts                     Loading state machine (idle/rehydrating/audio-initializing/loading-vrm/binding/ready/error)
│   └── toasts.ts                    push/dismiss, auto-dismiss after ttlMs
├── components/
│   ├── ChatPanel.tsx                Voice chat UI (no audio-enable button — StartGate handles it)
│   ├── CharacterPicker.tsx          Top-left picker + custom-instructions textarea
│   ├── StartGate.tsx                Welcome modal (gates audio init)
│   ├── Toasts.tsx                   Top-center stack
│   ├── ShortcutsModal.tsx           '?' opens, lists shortcuts
│   ├── MemoryInspector.tsx          Standalone dev panel (also reused inside DebugPanel's Memory tab)
│   └── debug/
│       ├── DebugPanel.tsx           Shift+D toggle, tabbed overlay (Turns/Trace/Metrics/Network/Memory), cached useSyncExternalStore snapshot
│       ├── TurnsTab.tsx             Five-column pipeline diff: Raw LLM → Post-think → Post-marker → TTS chunks → Sanitized (word-diff highlighting, '(dropped)' for sanitizer-nuked chunks)
│       ├── TraceTab.tsx             Live event feed, category filter chips + search
│       ├── MetricsTab.tsx           FPS + sparkline, P50/P95, stacked latency bars
│       ├── NetworkTab.tsx           Request-response pairing table
│       └── MemoryTab.tsx            Reuses MemoryInspector
├── hooks/
│   ├── useVRMLoader.ts              R3F useLoader + VRMLoaderPlugin + VRMAnimationLoaderPlugin
│   ├── useVRMAnimationLoader.ts     Bulk parallel animation loader
│   └── useGlobalShortcuts.ts        Centralized keydown with "in-input gate" (ignores M/Cmd+K when typing)
└── prompts/
    └── system.ts                    buildSystemPrompt({persona, customInstructions, memoryBlock, gestures, boundEmotions})

public/
├── vrm/{mika,ani}/model.vrm + animations/*.vrma + preview.png
├── wlipsync/audio-processor.js + wlipsync.wasm
├── vad/silero_vad_{v5,legacy}.onnx + vad.worklet.bundle.min.js
└── ort/ort-wasm-simd-threaded{,.jsep}.{mjs,wasm}

vite.config.ts                       Custom plugin serves /ort/* and /vad/* RAW before transform middleware (see §gotchas)
vitest.config.ts                     jsdom + fake-indexeddb/auto setup
```

## Critical gotchas (the expensive-to-rediscover ones)

Every one of these cost at least an hour. Search for `NOTICE:` in the code to find the authoritative explanation next to the code.

1. **VRM character swap leaves empty scene on return swap.** Three things interact:
   - `useLoader(GLTFLoader, url)` caches the parsed GLTF by URL. Same VRM instance comes back on remount.
   - `VRMUtils.removeUnnecessaryVertices` + `combineSkeletons` mutate the scene in place. Running them twice on the cached scene breaks skeleton bindings. **Fix**: `PREPARED_VRMS` WeakSet guards.
   - R3F's `<primitive>` detach path flips `object.visible = false`. **Fix**: force `vrm.scene.visible = true` on every mount.
   - Never `VRMUtils.deepDispose` on unmount — you'll kill the cached scene. Small memory cost (2 characters ≈ 20MB GPU) is acceptable.

2. **React 19 StrictMode breaks R3F v9 Canvas.** R3F's Canvas unmount effect schedules a 500ms `forceContextLoss()`. StrictMode's simulated unmount-remount reuses the same canvas root, but the pending timer fires afterward and kills the live WebGL context. Result: one frame, then black canvas forever. **Fix**: no `<StrictMode>` in `main.tsx`. Tradeoff: lose dev-only double-invocation safety checks.

3. **Vite refuses dynamic `import()` from `public/`.** ORT's WASM loaders (`ort-wasm-simd-threaded.jsep.mjs`) are dynamic-imported at runtime. Vite's transform middleware returns 500 with "This file is in /public…". **Fix**: `rawPublicAssets` plugin in `vite.config.ts` serves `/ort/*` and `/vad/*` raw bytes *before* Vite's transform layer.

4. **wlipsync data-URL worklet fails in Chromium.** The default bundle inlines worklet + WASM as data URIs. `audioWorklet.addModule(new URL('data:text/javascript;base64,…'))` is rejected. **Fix**: import from `wlipsync/wlipsync.js` (non-bundled), copy `audio-processor.js` + `wlipsync.wasm` to `public/wlipsync/`, manually `addModule('/wlipsync/audio-processor.js')` and `WebAssembly.compileStreaming(fetch('/wlipsync/wlipsync.wasm'))`.

5. **TTS 400 on non-speakable chunks.** ElevenLabs rejects emoji-only / HTML-only / punctuation-only input with `Invalid argument received. Text for a segment cannot be empty`. **Fix**: `tracedSanitize` in `speech-pipeline.ts` strips HTML tags, emoji, variation selectors, ZWJ; returns `null` if no letters/numbers/CJK remain; caller skips.

6. **Grok sometimes emits inline HTML** (`<span style="color:#00ff00">🎉</span>`) even with explicit no-markup rule. Sanitizer strips defensively. System prompt also explicitly forbids markup.

7. **Marker parser TAIL_HOLD = 2**. Holds last 2 chars in case `<|` is split across deltas. Emoji surrogate pairs are exactly 2 UTF-16 code units, so emoji-trailing replies would hit the sanitizer path → empty → 400. Fixed by the sanitizer, but the TAIL_HOLD constant is load-bearing — don't change it.

8. **Turn-controller duplicate-bubble bug.** Always reset `liveAssistant` + `liveEmotions` **before** emitting `'history'`. If you push to history, emit 'history' (subscriber renders), THEN reset — subscriber reads stale liveAssistant and renders both the finished entry and a live preview. Applies to `onStreamEnd` AND `commitInterruptedAssistant`.

9. **Turn.ts: skip flush/onStreamEnd after abort.** If `ac.signal.aborted`, early-return from the stream-loop-exit path before `categorizer.flush()` / `marker.flush()` / `options.onStreamEnd?.()`. Otherwise the residual tail re-emits literals through `onAssistantText` (rebuilding `liveAssistant` after barge-in reset it), then `onStreamEnd` pushes a phantom second copy. `speaker.abort()` in `finally` tears down TTS.

10. **Scribe ambient-audio tags** default on and insert `(instrumental music plays)` into transcripts. We pass `tagAudioEvents: false`. If we ever want ambient awareness, we'd do it via a separate signal, not inline transcript pollution.

11. **OpenRouter 4s US-endpoint floor.** Previously we were on `@openrouter/ai-sdk-provider` for Grok. TTFT was ~4s with no caching hint (`cache_control: {type:'ephemeral'}` is Anthropic-format only; Grok ignored it). User found the root cause: OpenRouter routes to US xAI endpoints. Direct xAI via `eu-west-1.api.x.ai/v1` drops to ~500ms. Current fix: direct `@ai-sdk/xai` with `baseURL` pinned to the EU region (overridable via `XAI_BASE_URL`).

12. **`useSyncExternalStore` requires stable `getSnapshot` identity.** If the snapshot-reading function returns a new array/object reference each call with unchanged data, React loops infinitely. `DebugPanel.tsx` uses a module-level cached ref invalidated only on last-seq change.

13. **Zustand `persist` hydrates synchronously** (localStorage is sync), so no flash-of-default on reload. We added a `hasHydrated` flag on `character.ts` anyway, as an explicit gate in case Zustand ever flips to async.

## Marker protocol (critical, used everywhere)

The LLM weaves inline markers with speech; the marker parser splits them into a literal stream (→ TTS) and a special stream (→ expression/animation):

- `<|ACT:{"emotion":"happy","intensity":0.8}|>` — facial expression + optional body animation (if preset binds emotion to a clip)
- `<|PLAY:jump|>` — gesture (whitelisted per preset; unknown ids drop silently)
- `<|DELAY:0.6|>` — pause in seconds (max 10s)

Allowed emotions: `happy / sad / angry / surprised / relaxed / neutral`. Animation registry (gestures + emotion bindings) is declared per-preset in `src/vrm/presets.ts`.

Both Mika and Ani have 13 clips each: idle + 5 emotion (blush=happy / sad / angry / surprised / relax=relaxed) + 7 gestures (clapping / goodbye / jump / look_around / thinking / sleepy / dance).

System prompt order (LOCKED — changing this may invalidate xAI prefix caching if we ever activate it):

1. Persona (per preset — stable per character)
2. Marker-protocol block: `## Expressing emotion`, `## Gestures`, `## Pausing`, `## Marker examples` (persona-agnostic — shared cacheable prefix across characters)
3. `## Rules`
4. `## Personal notes from the user` (custom instructions — semi-stable)
5. `## What you remember about them` (memory block — fully dynamic, last)

The `Marker examples` block was added specifically to push the stable prefix above xAI's 1024-token auto-cache floor. There's a regression test in `src/prompts/__tests__/system.test.ts` that asserts this.

## Observability (use it when debugging)

- **`Shift+D`** toggles the Debug panel. Five tabs:
  - **Turns** — five-column pipeline diff per assistant turn with word-level highlighting. THIS IS THE KILLER FEATURE for "why did TTS sound weird?" — you can see exactly which stage mangled text.
  - **Trace** — live event feed, category filter, search.
  - **Metrics** — FPS + sparkline, P50/P95 of `llm.first-token`, `first-audio`, `turn-total`, `fetch-sent`, `first-byte`. Last 20 turns as stacked bars.
  - **Network** — `/api/*` pairs with status + duration.
  - **Memory** — reuses MemoryInspector.
- Tracer is a module-level ring buffer (1000 events). No-op in production (DEV-gated).
- All pipelines emit events: `llm.*`, `categorizer.*`, `marker.*`, `ttsch.*`, `tts.*`, `vad.*`, `stt.*`, `anim.*`, `memory.*`, `turn.*`, `fps`.

## Conventions (follow these without asking)

- **No emojis** in code or UI unless user explicitly asks. The user has been consistent on this.
- **No semicolons** in `src/**/*.ts|tsx`. ESLint/Prettier config is informal but uniform. Exception: `server/lib/tts.ts` — user hand-formatted with semicolons; **never reformat this file**.
- **No `@moeru/std`** — that's the airi sibling monorepo. Here we use plain `err instanceof Error ? err.message : String(err)`.
- **`// NOTICE:` blocks** for workarounds. Format: rule/fact, root cause, source context, removal condition. Keep them with the code they describe when moving things.
- **No new abstractions** unless the third repetition forces it. Functional + closure-based DI; avoid classes unless extending browser APIs (mixers / audio nodes).
- **Don't add backward-compat shims**. If we change a shape, we change all callers.
- **Don't introduce new top-level deps without asking**, especially UI framework deps (no shadcn, no Radix, no framer-motion). Tailwind + small inline CSS only.
- **DEV-only debug surfaces** gate behind `import.meta.env.DEV`. Production must not ship the debug panel, `__dbg_*` globals, or tracer emit calls (tracer handles this at the singleton level — `emit` is a no-op in prod).
- **Error handling**: trust internal code / framework guarantees; only validate at system boundaries (user input, external APIs).

## User-interaction patterns

- The user is technical, reads code, gives precise bug reports ("the scene is empty on return swap", "TTS is gibberish sometimes") — take these as diagnostic.
- **They do not want me to commit.** They review and commit manually. Never `git commit` unless explicitly asked.
- For substantial multi-file work they expect a sub-agent (general-purpose) run in background with a full self-contained brief. Keep the main-thread context clean.
- **Always try to distribute tasks using sub-agents.** Default to delegating: exploration, research, multi-file edits, verification runs, and any work that would bloat the main-thread context should go to a sub-agent with a self-contained brief. The main thread stays as the orchestrator. Only skip delegation for trivially small edits (single-file, few-line changes) or when the user has asked for a direct one-shot change.
- For exploratory questions ("how could we do X?") they want 2-3 sentences with a recommendation and the main tradeoff, not a plan. Don't implement until they agree.
- They trust the process: if you tell them a sub-agent is running and will report back, they'll wait.
- They'll push back if an answer is too long or too cautious. Be direct.
- They manage `package.json` themselves. A blind upgrade once surprised me but the fallout was small — the codebase is resilient.
- They like explanatory insights when the architectural "why" is non-obvious, but otherwise prefer results.

## Runtime essentials

```bash
pnpm dev            # concurrently runs Vite (:5173) + Hono (:8787)
pnpm typecheck      # tsc -b --noEmit across all tsconfigs
pnpm test:run       # Vitest run (memory + observability + stores + prompts + chat route tests)
pnpm build          # tsc + vite build (production bundle)
```

`.env` needs (server-only):
- `XAI_API_KEY` (plus optional `XAI_BASE_URL` — defaults to `https://eu-west-1.api.x.ai/v1` in code)
- `ELEVENLABS_API_KEY`
- optional `ELEVENLABS_VOICE_ID` (overrides Rachel default for the TTS route; per-character voices are in `presets.ts` and take precedence at call time)

`/api/health` reports key presence.

## Verification flow (use this for any substantial change)

1. `pnpm typecheck` clean.
2. `pnpm test:run` all pass.
3. `pnpm dev` in background, 4s wait.
4. **Always drive the browser via the Playwright CLI, not the MCP.** Use the shell, e.g.:

   ```bash
   playwright-cli open http://localhost:5173 --headed --persistent
   ```

   `--headed` keeps the window visible so the user can watch the run; `--persistent` reuses a profile directory so localStorage / IndexedDB / granted permissions survive across invocations (critical for Mika↔Ani swap and memory regressions). Drive subsequent actions through the same CLI session. The standard smoke:
   - Clear localStorage, reload.
   - StartGate → pick Mika → Start.
   - Send `"Hi, I'm Captain and I live in Tokyo."` Wait for reply. Expect a live Mika reply with emotion chip.
   - Switch to Ani, verify new VRM renders.
   - Switch back to Mika, verify VRM is still there (not empty — that's the cache-disposal regression).
   - Shift+D → every tab renders.
   - Zero console errors (12-24 VRMA spec-version warnings are tolerable, pre-existing).
5. Kill dev servers: `pkill -f "pnpm dev" 2>/dev/null; pkill -f vite; pkill -f "tsx.*server"`.

For latency-related changes, additionally run the 3-turn flow (`"Hi, I'm Captain and I live in Tokyo."` → `"What's your favourite thing about riding?"` → `"Tell me something about yourself."`) and read `llm.first-token` / `first-audio` / `fetch-sent` / `first-byte` from the Metrics tab.

## Active threads at handoff time

- No in-flight sub-agents. All recent work done.
- `@openrouter/ai-sdk-provider` is left installed (no longer imported) as a rollback option.
- `PLAN.md` still references the old `xai/grok-4.1-fast-non-reasoning` OpenRouter slug and routing in ~16 places. It's a historical planning doc; not operational. Clean rewrite pass if you want accuracy, but it won't affect runtime.
- No commits pending; user commits manually.

## Don'ts (bitter experience)

- Don't commit.
- Don't rewrite `server/lib/tts.ts` formatting.
- Don't add React StrictMode back.
- Don't `VRMUtils.deepDispose` on character swap.
- Don't run `VRMUtils.removeUnnecessaryVertices` / `combineSkeletons` twice on the same VRM instance.
- Don't `useLoader.clear()` casually — you'll force re-fetches on every swap.
- Don't emit events between `history.push(...)` and `resetLive()`. Reset first.
- Don't flush categorizer/marker after abort.
- Don't swap provider lightly. We're on xAI direct + EU region for a reason now.
- Don't introduce a client-side API key — all provider calls go through the Hono server.
- Don't fake-retry a failing external call in a sleep loop. Diagnose root cause.
