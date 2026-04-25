/**
 * Streaming <|…|> marker extractor.
 *
 * The LLM weaves action/emotion markers inline with its speech:
 *
 *   "Hi there! <|ACT:{\"emotion\":\"happy\",\"intensity\":0.8}|> How's
 *    your day? <|DELAY:0.5|> I missed you."
 *
 * This parser consumes text deltas and separates the two streams:
 *   - `onLiteral(text)` — everything outside markers (→ TTS chunker)
 *   - `onSpecial(marker)` — the raw <|…|> strings (→ action queue)
 *
 * It buffers a small tail so a marker split across deltas (e.g. "<|AC"
 * then "T:{...}|>") is detected correctly.
 */

const TAG_OPEN = '<|'
const TAG_CLOSE = '|>'

export interface MarkerParserOptions {
  onLiteral: (text: string) => void | Promise<void>
  onSpecial: (marker: string) => void | Promise<void>
}

export function createMarkerParser(options: MarkerParserOptions) {
  let buffer = ''
  let inTag = false

  // Minimum tail we must hold while outside a tag, in case TAG_OPEN is split
  // across chunks. TAG_OPEN is 2 chars so holding back 1 char is enough —
  // keep 2 for safety across Unicode surrogate edges.
  const TAIL_HOLD = TAG_OPEN.length

  return {
    async consume(delta: string) {
      if (!delta) return
      buffer += delta

      while (buffer.length > 0) {
        if (!inTag) {
          const openIdx = buffer.indexOf(TAG_OPEN)
          if (openIdx < 0) {
            // No tag-open seen. Emit everything except the last TAIL_HOLD
            // chars in case the next delta starts with the close of a
            // split TAG_OPEN.
            if (buffer.length <= TAIL_HOLD) return
            const emit = buffer.slice(0, -TAIL_HOLD)
            buffer = buffer.slice(-TAIL_HOLD)
            await options.onLiteral(emit)
            return
          }
          if (openIdx > 0) {
            const emit = buffer.slice(0, openIdx)
            buffer = buffer.slice(openIdx)
            await options.onLiteral(emit)
          }
          inTag = true
        } else {
          const closeIdx = buffer.indexOf(TAG_CLOSE)
          if (closeIdx < 0) return // wait for more data
          const marker = buffer.slice(0, closeIdx + TAG_CLOSE.length)
          buffer = buffer.slice(closeIdx + TAG_CLOSE.length)
          await options.onSpecial(marker)
          inTag = false
        }
      }
    },

    async flush() {
      if (buffer.length === 0) return
      if (!inTag) {
        // Tail-hold bytes are safe to emit now that the stream is over.
        await options.onLiteral(buffer)
      }
      // If we're still mid-tag at flush, the marker was truncated — drop it.
      buffer = ''
      inTag = false
    },
  }
}

// ---------------------------------------------------------------------------
// Marker payload parsing
// ---------------------------------------------------------------------------

export interface ActMarker {
  type: 'act'
  emotion: string
  intensity: number
}

export interface DelayMarker {
  type: 'delay'
  seconds: number
}

export interface PlayMarker {
  type: 'play'
  /** Gesture id from the preset's animation registry (e.g. 'jump'). */
  id: string
}

export interface OutfitMarker {
  type: 'outfit'
  /** Variant id from the preset's `models` registry (e.g. 'pajama'). */
  id: string
}

export type ParsedMarker =
  | ActMarker
  | DelayMarker
  | PlayMarker
  | OutfitMarker
  | null

/**
 * Parses a raw `<|…|>` marker string into a typed payload. Returns null if
 * the marker is malformed — caller should drop it (we do not crash the
 * character over bad LLM output).
 *
 * Accepted forms:
 *   <|ACT:{"emotion":"happy","intensity":0.8}|>
 *   <|DELAY:1.5|>
 *   <|PLAY:jump|>
 */
export function parseMarker(raw: string): ParsedMarker {
  const inner = raw.replace(/^<\|/, '').replace(/\|>$/, '').trim()

  // ACT: { "emotion": "...", "intensity": 0..1 }
  const actMatch = /^ACT\s*:\s*(\{[\s\S]*\})$/i.exec(inner)
  if (actMatch) {
    try {
      const payload = JSON.parse(actMatch[1]) as {
        emotion?: unknown
        intensity?: unknown
      }
      const emotion = typeof payload.emotion === 'string' ? payload.emotion : null
      const intensity =
        typeof payload.intensity === 'number' ? payload.intensity : 1
      if (!emotion) return null
      return {
        type: 'act',
        emotion: emotion.toLowerCase(),
        intensity: Math.max(0, Math.min(1, intensity)),
      }
    } catch {
      return null
    }
  }

  // DELAY: <seconds>
  const delayMatch = /^DELAY\s*:\s*([\d.]+)$/i.exec(inner)
  if (delayMatch) {
    const secs = Number(delayMatch[1])
    if (!Number.isFinite(secs) || secs < 0) return null
    return { type: 'delay', seconds: Math.min(secs, 10) } // cap at 10s for safety
  }

  // PLAY: <gesture-id>
  // Accept `snake_case` ids matching our preset registry. The animation
  // controller whitelists by id — unknown gestures are dropped silently.
  const playMatch = /^PLAY\s*:\s*([a-z][a-z0-9_]*)$/i.exec(inner)
  if (playMatch) {
    return { type: 'play', id: playMatch[1].toLowerCase() }
  }

  // OUTFIT: <variant-id>
  // Same shape as PLAY. The turn handler whitelists against the active
  // preset's `models` and drops unknown ids silently.
  const outfitMatch = /^OUTFIT\s*:\s*([a-z][a-z0-9_]*)$/i.exec(inner)
  if (outfitMatch) {
    return { type: 'outfit', id: outfitMatch[1].toLowerCase() }
  }

  return null
}
