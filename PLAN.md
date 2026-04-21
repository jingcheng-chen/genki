# AI Companion — Concept, Tech Stack, and Implementation Plan

> A minimal, self-hosted 3D AI companion built on VRM + Web technology. Draws architectural patterns from AIRI (`moeru-ai/airi`) but slims them to the essentials and adds a human-curve memory system.

---

## 1. Vision & Scope

### What we're building
A browser-first (and optionally Electron-wrapped) AI companion:

- A **VRM avatar** that idles naturally, emotes, lip-syncs, and looks at the user.
- Powered by a **streaming LLM** that emits structured emotion/action markers inline with its speech.
- Talks back via a **TTS provider** with low-latency sentence-chunked synthesis.
- Listens via **mic + VAD** and can be **interrupted** mid-speech (barge-in).
- Remembers you across sessions via a **human-curve memory system**: fact extraction after each turn, progressive compression of older facts, retrieval-induced reinforcement.
- Supports **multiple characters** with per-character voice, VRM model, and persona.
- Supports **i18n** for multilingual conversation.

### What we're NOT building (v1)
- Vision / screen capture (topic 11) — deferred
- Wake word detection (topic 13) — deferred, push-to-talk + VAD is fine
- Formal privacy UX (topic 14) — local-first by default, no cloud sync
- Tool calls / MCP — not in scope
- Desktop (Electron) shell — web-only for v1

### Design principles
1. **Local-first**. Everything runs on-device. LLM/TTS/STT can be cloud or local, but the *companion* (state, memory, character) is yours.
2. **Streaming end-to-end**. First audio within 1 second of user-done-speaking. First expression/gesture within 500ms.
3. **No content filtering** (beyond structural post-processing like stripping `<think>` tags from TTS).
4. **Observable**. Every stage of the pipeline emits latency measurements.
5. **Provider keys live server-side.** A thin Hono proxy holds the OpenRouter and ElevenLabs API keys. The browser never sees them; users never configure them. Client calls `/api/chat`, `/api/tts`, `/api/stt` — those endpoints fan out to the real providers.
6. **Swappable media providers**. TTS and STT sit behind the proxy adapters (ElevenLabs today; OpenAI / Whisper are drop-in alternatives). LLM is hardcoded to **`xai/grok-4.1-fast-non-reasoning` via OpenRouter** for v1, also behind the same adapter shape.
6. **Boring where it should be boring**. IndexedDB for storage, Web Audio API for playback, `@pixiv/three-vrm` for rendering. Novelty concentrated in the memory system.

---

## 2. Architecture Overview

```
                       ┌────────────────────────────────────────────────┐
                       │                BROWSER (React)                  │
                       │   character picker · settings · debug panel     │
                       └───────────────┬────────────────────────────────┘
                                       │
┌──────────────┐   mic   ┌─────────┐   ▼   ┌─────────────────┐
│ getUserMedia ├────────▶│   VAD   ├──────▶│ Turn Controller │────────────┐
└──────────────┘         └─────────┘       │ (state machine) │            │
                                           └────────┬────────┘            │
                                                    │                     │
                             ┌──────────────────────┼─────────────────┐   │
                             ▼                      ▼                 ▼   │
                       fetch /api/stt        fetch /api/chat    fetch /api/tts
                             │                      │                 │
     ══════════════════════════════════════════════════════════════════════════
                                      HONO SERVER (holds keys)
                             │                      │                 │
                             ▼                      ▼                 ▼
                     ┌───────────────┐    ┌────────────────┐  ┌──────────────┐
                     │  STT Proxy    │    │  LLM Proxy     │  │  TTS Proxy   │
                     │  ElevenLabs   │    │  OpenRouter →  │  │  ElevenLabs  │
                     │  Scribe       │    │  xai/grok-     │  │  Flash v2.5  │
                     │               │    │  4.1-fast-     │  │              │
                     │               │    │  non-reasoning │  │              │
                     └───────┬───────┘    └────────┬───────┘  └───────┬──────┘
                             │                     │                  │
                             │   transcript        │ stream of tokens │ audio buffer
                             ▼                     ▼                  ▼
                        ┌──────────────────────────────────────────────────┐
                        │            Response Pipeline                      │
                        │                                                   │
                        │  [marker parser] → [categorizer (<think> strip)]  │
                        │        │                  │                       │
                        │        ▼                  ▼                       │
                        │   ACT queue           TTS chunker                 │
                        │   (emotions,         (sentence flush)              │
                        │    delays)                │                       │
                        │        │                  ▼                       │
                        │        │           TTS request queue              │
                        │        │                  │                       │
                        │        │                  ▼                       │
                        │        │         AudioBuffer playback             │
                        │        │          │          │                    │
                        │        │          ▼          ▼                    │
                        │        │    destination   wlipsync node           │
                        │        │                      │                   │
                        │        ▼                      ▼                   │
                        │  VRM Expression         Phoneme weights           │
                        │    Manager         (A/E/I/O/U)                    │
                        └────────┬───────────────────┬─────────────────────┘
                                 │                   │
                                 ▼                   ▼
                        ┌──────────────────────────────────┐
                        │       Render Loop (Three.js)     │
                        │  mixer.update · expressionManager │
                        │  · springBoneManager · lookAt    │
                        │  · blink · saccades              │
                        └──────────────────────────────────┘

                        ┌──────────────────────────────────┐
                        │     Memory System (background)    │
                        │  fact extractor · compactor       │
                        │  · retriever (injected in prompt) │
                        └──────────────────────────────────┘
```

### Subsystems
1. **Renderer** — VRM + animations + expressions
2. **Speech pipeline** — TTS synthesis → playback → lip-sync
3. **LLM pipeline** — streaming text → marker/categorizer → events
4. **Input pipeline** — mic → VAD → STT → turn controller
5. **Turn controller** — state machine gating who speaks when
6. **Memory system** — fact extraction + decay + retrieval
7. **Character system** — persona + voice + visual model bundle
8. **Observability** — per-stage latency + frame-step tracing

---

## 3. Tech Stack

### Runtime
| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript 5.x | Strong inference for streaming/union types |
| Package manager | pnpm | Workspace-friendly, fast |
| Bundler | Vite | Fast HMR, native ESM |
| Framework | React 19 + TypeScript | Fits `@react-three/fiber`, wide ecosystem |
| State | Zustand | Minimal boilerplate; `persist` middleware for localStorage/IndexedDB |
| Hooks / utilities | Custom hooks + selected libs (`usehooks-ts`, `@use-gesture/react` as needed) | Replace VueUse composables case-by-case |
| Styling | Tailwind CSS v4 | CSS-first config, atomic utilities |
| i18n | `react-i18next` + `i18next` | De-facto React i18n; hook-based API |
| Testing | Vitest + `@testing-library/react` | Native ESM, TS-first |

### Rendering
| Concern | Library | Version |
|---|---|---|
| 3D core | `three` | `^0.184` |
| VRM loader | `@pixiv/three-vrm` | `^3.5` |
| VRM animation | `@pixiv/three-vrm-animation` | `^3.5` |
| React ↔ Three.js | `@react-three/fiber` + `@react-three/drei` | `^9`, `^9` |
| Post-processing | `@react-three/postprocessing` | `^3` |

### Audio
| Concern | Library |
|---|---|
| Playback | Web Audio API (native) |
| Resampling worklet | `libsamplerate.js` (from AIRI) |
| VAD | `@ricky0123/vad-web` (Silero) |
| Lip-sync | `wlipsync@^1.3` + AIRI's profile JSON |

### LLM / TTS / STT
| Concern | Primary | Fallback / Notes |
|---|---|---|
| LLM client (server-side) | Vercel AI SDK — `ai` + `@openrouter/ai-sdk-provider` | `streamText({ model: openrouter('xai/grok-4.1-fast-non-reasoning') })`. Streaming, abortable. **Hardcoded** — no user-facing model picker |
| TTS (server-side) | ElevenLabs — `@elevenlabs/elevenlabs-js`, model `eleven_flash_v2_5`, PCM stream | Proxied via `/api/tts`. Target <300ms first-chunk latency |
| STT (server-side) | ElevenLabs Scribe — same SDK, HTTP endpoint | Proxied via `/api/stt`. Consider their realtime WebSocket STT later if barge-in quality needs it |

### Storage
| Concern | Library |
|---|---|
| Storage abstraction | `unstorage` |
| Browser backend | `unstorage/drivers/indexedb` |
| Key-value helper (optional) | `idb-keyval` — simpler for single-map use cases |

### Server / API proxy
| Concern | Library | Notes |
|---|---|---|
| Server framework | Hono (`hono`) | Tiny, TS-first, deploys unchanged to Cloudflare Workers / Vercel / Node / Bun |
| Streaming bridge | Hono + Vercel AI SDK `toDataStreamResponse()` | Server streams token chunks back as SSE; client consumes as a `ReadableStream` |
| Env management | `.env` (local) + host's secrets (prod) | `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY` — **never** `VITE_*` prefixed |
| Dev workflow | Hono on `:8787`; Vite `server.proxy` forwards `/api/*` to it | One `pnpm dev` script runs both via `concurrently` |
| Suggested deploy target | Cloudflare Workers + Pages | Free tier handles a personal companion; global latency; Hono has first-class CF adapter |

### Why Vercel AI SDK via OpenRouter
One thing we need from the SDK: a typed, abortable streaming API (`streamText`, `fullStream` AsyncIterable). OpenRouter is used for routing because:
- It exposes `xai/grok-4.1-fast-non-reasoning` under a single account alongside dozens of other models, so switching if xAI has an outage is a one-line model-string change.
- Unified billing / observability dashboard for all LLM traffic.
- `@openrouter/ai-sdk-provider` plugs into the Vercel AI SDK identically to a first-party provider.

```ts
// server/lib/llm.ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })
export const chatModel = openrouter('xai/grok-4.1-fast-non-reasoning')
```

The same `chatModel` is used for **both** conversation turns and memory curation (fact extraction + compaction). Single API key, single billing relationship, one provider-outage risk to monitor. The `<think>` stripping layer is kept anyway as defensive code in case a reasoning model is ever swapped in.

### Why ElevenLabs for both TTS and STT
Single vendor, single SDK, one API key, one billing relationship. Flash v2.5 TTS is the best-latency cloud option available (<300ms first audio on good networks) and Scribe STT is competitive with Whisper on most benchmarks. Trade-off is vendor lock-in; the adapter layer keeps both swappable (OpenAI TTS + Whisper are the standard drop-in replacements).

---

## 4. Data Model

### 4.1 Character

```ts
// src/types/character.ts

export interface Character {
  id: string                           // nanoid
  name: string
  version: string                      // semver

  /** Assembled into the system message at runtime */
  persona: {
    systemPrompt: string               // core instructions
    description?: string               // who they are
    personality?: string               // how they behave
    greetings?: Record<Locale, string> // first-turn messages per language
  }

  // LLM is global (xAI Grok, hardcoded). Only per-character knobs are
  // temperature and max output tokens, exposed if needed:
  llm?: {
    temperature?: number
    maxOutputTokens?: number
  }

  tts: {
    voiceId: string                    // ElevenLabs voice ID
    modelId?: string                   // defaults to 'eleven_flash_v2_5'
    rate?: number                      // 0.5–2.0
    pitch?: number                     // -12..12 semitones
    language?: Locale
  }

  vrm: {
    presetId: string                   // references the preset registry in /public/vrm/
  }

  locale: Locale                       // primary language for the character

  createdAt: string                    // ISO
  updatedAt: string
}

export type Locale = 'en-US' | 'zh-CN'   // v1 target set; extend later
```

### 4.2 Session + Messages

```ts
// src/types/session.ts

export interface ChatSession {
  id: string
  characterId: string
  userId: string                       // for multi-profile support
  title?: string                       // user-editable
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'system' | 'user' | 'assistant'
  content: string                      // original, before categorization
  speech?: string                      // post-categorizer speech-only text (for replay)
  reasoning?: string                   // content inside <think> tags (kept for defence — non-reasoning model shouldn't emit any)
  actions?: ActMarker[]                // emotions/delays emitted in this message
  createdAt: string
  generation: number                   // incremented to invalidate stale stream updates
}

export interface ActMarker {
  type: 'emotion' | 'delay'
  emotion?: { name: string; intensity: number }
  delay?: number                       // seconds
  position: number                     // char offset in the original content
}
```

### 4.3 Memory (see §5 for detail)

```ts
// src/types/memory.ts

export interface MemoryFact {
  id: string
  characterId: string
  userId: string

  content: string                      // natural-language fact
  category: 'durable' | 'preference' | 'episodic' | 'emotional' | 'relational'

  createdAt: string                    // ISO
  lastAccessedAt: string               // reset on reinforcement
  accessCount: number

  importance: number                   // 0..1, assigned by extractor
  compressionLevel: 0 | 1 | 2 | 3      // 0=full, 3=single-clause summary

  sourceMessageIds: string[]           // provenance for debugging
}
```

### 4.4 VRM preset registry

VRM models are **bundled, not user-uploaded** in v1. A small curated list lives in `/public/vrm/` and is declared in a single registry file:

```ts
// src/vrm/presets.ts

export interface VRMPreset {
  id: string                           // 'aria', 'mizuki', 'leo'
  name: string                         // display name
  modelUrl: string                     // '/vrm/aria/model.vrm'
  previewUrl: string                   // '/vrm/aria/preview.png'
  animations: {
    idle: string                       // '/vrm/aria/animations/idle.vrma' — required
    greet?: string                     // optional action clips
    wave?: string
    think?: string
    // extendable — the expression-controller reads from this map
  }
  licence: string                      // short text for attribution UI
  defaultCameraOffset?: [number, number, number]
}

export const VRM_PRESETS: VRMPreset[] = [
  {
    id: 'aria',
    name: 'Aria',
    modelUrl: '/vrm/aria/model.vrm',
    previewUrl: '/vrm/aria/preview.png',
    animations: {
      idle: '/vrm/aria/animations/idle.vrma',
    },
    licence: 'CC-BY 4.0 — VRoid AvatarSample_A',
  },
  // + 1-2 more as we grow the v1 catalog
]
```

**v1 scope**: one preset, one idle animation. The registry is shaped so adding a second/third preset and additional `.vrma` clips is a matter of dropping files into `/public/vrm/{id}/` and appending a registry entry — no code changes beyond the list itself.

A character's `vrm.presetId` is the only link to this registry. Characters are completely decoupled from asset URLs; swapping a preset across characters is a one-field change.

---

## 5. Memory System — the novel piece

### Design goals
1. **Human-shaped decay**: older = lossier unless reinforced.
2. **Bounded size**: after months of use, the memory file stays on the order of hundreds of entries, not thousands.
3. **Fact-level, not message-level**: we extract *what matters*, not *what was said*.
4. **Simple text format**: debuggable, portable, no DB required.
5. **Retrieval-induced reinforcement**: facts that get referenced in the current turn get their stability bumped (like actual human memory).

### The model

We borrow Ebbinghaus's forgetting curve with Pimsleur-style spaced reinforcement:

```
retention(t) = exp(-t / S)
```

where `t` is time since last access (hours) and `S` is *stability* in hours. Stability grows with:
- Importance (scored 0..1 by the extractor)
- Access count (each recall bumps it)
- Category (durable facts have a floor)

```ts
function computeStability(fact: MemoryFact): number {
  const base = CATEGORY_BASE_STABILITY[fact.category]   // e.g. durable=∞, episodic=72h
  const importanceMul = 1 + 4 * fact.importance         // 1..5×
  const accessMul = 1 + Math.log2(1 + fact.accessCount) // 1..~5×
  return base * importanceMul * accessMul
}

function retentionScore(fact: MemoryFact, now: Date): number {
  const stability = computeStability(fact)
  const hoursSinceAccess = (now.getTime() - Date.parse(fact.lastAccessedAt)) / 3.6e6
  return Math.exp(-hoursSinceAccess / stability)
}
```

### Lifecycle

```
 ┌─────────────────┐
 │  New user turn  │
 └────────┬────────┘
          │
          ▼
 ┌─────────────────────────┐
 │  Retrieve relevant      │   ← top-K facts by (importance × retention × recency)
 │  facts for system prompt│
 └────────┬────────────────┘
          │
          ▼
 ┌─────────────────┐
 │   LLM responds  │
 └────────┬────────┘
          │
          ▼
 ┌─────────────────────────────────────┐
 │  Fact extractor (cheap model)       │   ← runs async after assistant finishes
 │                                     │
 │  Input: last user turn + assistant  │
 │         turn + currently retrieved  │
 │         facts                       │
 │                                     │
 │  Output:                             │
 │   - NEW facts (content + category + │
 │     importance 0..1)                 │
 │   - REINFORCED fact IDs (facts that │
 │     got referenced / confirmed)     │
 │   - OUTDATED fact IDs (superseded)  │
 └────────┬────────────────────────────┘
          │
          ▼
 ┌─────────────────────────┐
 │  Apply updates:         │
 │  - insert new facts     │
 │  - bump accessCount +   │
 │    lastAccessedAt on    │
 │    reinforced           │
 │  - delete outdated      │
 └────────┬────────────────┘
          │
          ▼
 (background, daily or per N turns)
 ┌─────────────────────────┐
 │  Compactor pass         │
 │                         │
 │  For facts with         │
 │  retention < 0.2:       │
 │    bump compressionLevel│
 │    rewrite content w/   │
 │    cheap LLM to be      │
 │    shorter & lossier    │
 │                         │
 │  For facts at level 3   │
 │  with retention < 0.05: │
 │    delete               │
 └─────────────────────────┘
```

### Storage format (human-readable markdown)

One file per `(characterId, userId)` pair, stored in `unstorage` under
`local:memory/{userId}/{characterId}.md`.

```md
<!-- memory-file-version: 1 -->
<!-- character: Aria -->
<!-- user: alice -->

## Durable
- [f_a8c] Name: Alice (i:1.0 · acc:47 · seen:2026-04-21)
- [f_b2d] Location: Tokyo, Japan (i:0.9 · acc:23 · seen:2026-04-18)
- [f_c71] Profession: frontend developer (i:0.8 · acc:18 · seen:2026-04-20)

## Preferences
- [f_d04] Dislikes cilantro and loud music (i:0.6 · acc:3 · seen:2026-03-10 · L1)
- [f_e66] Prefers dark UI themes (i:0.4 · acc:1 · seen:2026-04-15)

## Recent episodic (L0, full detail)
- [f_f11] 2026-04-21: Passed React certification exam, was visibly excited (i:0.8 · acc:1)
- [f_f12] 2026-04-20: Debated Vue 2 → Vue 3 migration strategy (i:0.5 · acc:0)
- [f_f10] 2026-04-18: Stressed about Friday deadline for shipping feature (i:0.7 · acc:0)

## Earlier this month (L1, compressed)
- [f_e92] Week of 2026-04-13: Explored three-vrm library for a companion project (i:0.6 · acc:2)
- [f_e71] Week of 2026-04-06: Planned AI-companion architecture, chose VRM over Live2D (i:0.5 · acc:1)

## March (L2, heavily compressed)
- [f_d20] March 2026: Started the AI companion side project (i:0.5 · acc:4)
- [f_d21] March 2026: Ongoing React/Vue consulting work (i:0.3 · acc:0)

## Older (L3, summary only)
- [f_a04] 2026 Q1: Various frontend engineering work (i:0.3 · acc:0)
```

The file is **the source of truth**. A thin index is cached in-memory for retrieval queries.

### Prompt injection

Before each LLM call, the retriever selects:
- **All durable + preference facts** (small, high-value)
- **Top-K episodic/emotional facts** by `importance × retention` (K ≈ 8-12)
- **All L2/L3 summaries** (they're already compact, and cheap to include)

It assembles a memory block that goes into the system message:

```
You remember the following about {user}:

About them:
- Their name is Alice.
- They live in Tokyo, Japan.
- They're a frontend developer.
- They dislike cilantro and loud music.

Recent context:
- Yesterday they passed their React certification exam and were excited.
- This week they've been debating Vue 2 → 3 migration.

Longer history:
- They've been working on an AI companion side project since March.
- They've done various frontend consulting work in 2026.
```

### The fact extractor prompt (skeleton)

```
You are a memory curator for a conversational AI companion.

Given:
- The user's last message
- The assistant's last reply
- The existing memory facts that were retrieved for this turn

Output JSON with three arrays:
1. `new_facts`: facts NOT already in memory that are durable enough to remember.
   Each: { content: string, category: ..., importance: 0..1 }
   - importance = 1.0 for identity/permanent (name, location, relationships)
   - importance = 0.7-0.9 for strong preferences and current projects
   - importance = 0.3-0.6 for recent episodes and feelings
   - importance < 0.3: DO NOT store (noise)
2. `reinforced_fact_ids`: existing fact IDs that were referenced or confirmed in this turn.
3. `outdated_fact_ids`: existing fact IDs that this turn supersedes
   (e.g. user changed their mind, moved, finished a project).

Guidelines:
- Don't store the conversation itself. Store what the user IS, WANTS, FEELS, or DID.
- Don't store trivia ("user said 'hi'"). Store signal.
- Consolidate: prefer updating existing facts over creating duplicates.
- Output only JSON, no prose.
```

### Compaction prompt (runs per-fact or per-group)

```
Compress the following fact to {target_length_words} words, preserving what a
friend would remember from it {time_ago_description} later. Drop specifics,
keep gist.

Fact: {original}

Output: one sentence, no quotes, no preamble.
```

### Implementation notes

- **Run extraction off the critical path.** Don't block the next user turn on it. Use a queue.
- **Same model as conversation** (`xai/grok-4.1-fast-non-reasoning`). Single API key, single billing line, one rate-limit bucket to monitor. Grok's non-reasoning variant is fast enough for the curator path without burning reasoning tokens on structured-output extraction.
- **Deduplication.** Before inserting a new fact, compare (case-insensitive, normalized) against recent facts in the same category. If similar, reinforce the existing instead.
- **Privacy.** The memory file is just text — users can open, edit, delete it directly.
- **Export/import.** The markdown *is* the export format. Copy the file, you copy the memory.
- **"Forget this" command.** User says "forget that" → current turn's just-added facts get dropped, previous turn's reinforcements rolled back (within a small undo window).

### Why not embeddings?
We could add them. But:
- The token cost of always-included memory + top-K episodic facts is cheap (~1-2k tokens).
- Embedding-based retrieval adds a vector DB dependency and a second failure mode.
- Human-curve decay produces a much more *intuitive* "she remembers what matters" feel than nearest-neighbor search.
- If needed later, embeddings can be layered on top — store an embedding per fact, use it for retrieval instead of `importance × retention`. Everything else stays the same.

---

## 6. Runtime Pipelines

### 6.1 Turn state machine

```
 IDLE ──[user starts speaking (VAD)]──▶ LISTENING
   ▲                                       │
   │                                       │ [VAD silence timeout
   │                                       │  OR push-to-talk released]
   │                                       ▼
   │                                   TRANSCRIBING
   │                                       │
   │                                       │ [STT result]
   │                                       ▼
   │                                   THINKING
   │                                       │
   │                                       │ [first token]
   │                                       ▼
   │                                   SPEAKING
   │                                       │
   │                                       │ [playback done]
   │                                       │
   │                              ┌────────┼────────┐
   │                              │        │        │
   │                 [user        │        │    [stream ended,
   │                  barges in]  │        │     no more audio]
   │                              ▼        ▼
   │                          INTERRUPTED  IDLE
   │                              │
   └──────────────────────────────┘
```

Interruption (**barge-in**) is the one non-obvious transition: when VAD fires while the assistant is still SPEAKING, we:
1. Abort the TTS stream (abort signal into the speech pipeline → cancels in-flight TTS requests).
2. Abort the LLM stream (abort signal into `streamText`).
3. Stop the current `AudioBufferSourceNode`.
4. Flush the emotion queue and return VRM to neutral.
5. Optionally: duck, don't cut, if the user's VAD was a false positive (500ms grace window before full abort).
6. Add a truncated assistant message to the history: `"{partial-text} [interrupted]"` — the LLM needs to see what it got out so it doesn't repeat itself.
7. Transition to LISTENING.

### 6.2 Speech pipeline

```
assistant text delta ─▶ marker parser ─▶ [literal] ─▶ categorizer ─▶ speech chunks
                                    │                  │
                                    │                  └▶ reasoning (UI only)
                                    │
                                    └▶ [special] <|ACT:...|> ─▶ emotion queue
                                                     <|DELAY:N|> ─▶ delay queue

speech chunks ─▶ TTS chunker ─▶ TTS request queue ─▶ TTS provider
                                                        │
                                                        ▼
                                              AudioBuffer decode
                                                        │
                                                        ▼
                                              Playback manager
                                              (max 1 voice,
                                               priority, abortable)
                                                        │
                                          ┌─────────────┴─────────────┐
                                          ▼                           ▼
                                 audioContext.destination      wlipsync worklet
                                                                      │
                                                                      ▼
                                                          { A, E, I, O, U } weights
                                                                      │
                                                                      ▼
                                                          VRM expressionManager
                                                          (aa, ih, ou, ee, oh)
```

**TTS chunker strategy** (copied from AIRI with tuning):
- Boost first 2 chunks → aggressive early flush (target <800ms to first audio).
- Hard flush on `.?!…` → sentence-aligned prosody.
- Soft flush on `,;:` only if buffer > 12 words.
- Max buffer 20 words before forced flush.
- Markers and delays count as hard flush boundaries.

### 6.3 Render loop (per frame)

```tsx
// Inside a <Canvas> child. vrm / mixer / emotionController live in refs.
useFrame((_, delta) => {
  mixerRef.current?.update(delta)                         // idle .vrma
  vrmRef.current?.humanoid.update()

  vrmRef.current?.lookAt?.update(delta)                   // tracks camera or drifting target
  blinkRef.current?.update(vrmRef.current, delta)         // periodic with jitter
  saccadesRef.current?.update(vrmRef.current, lookAtTarget.current, delta)

  emotionRef.current?.update(delta)                       // smooth lerp toward current emotion
  lipSyncRef.current?.update(vrmRef.current, delta)       // wlipsync → aa/ih/ou/ee/oh

  vrmRef.current?.expressionManager?.update()             // commit blendshape weights
  vrmRef.current?.springBoneManager?.update(delta)        // hair/cloth physics
})
```

### 6.4 React + R3F gotchas

Three patterns that catch people:

1. **Keep per-frame values in refs, not React state.** Lip-sync weights, emotion intensities, and lookAt targets change every ~16ms. Putting them in `useState` triggers a React render per frame and you'll drop to 20fps. Use `useRef` and mutate Three.js objects directly inside `useFrame`. Zustand state is fine *only* if you read it imperatively via `useStore.getState()` inside `useFrame` — never via the `useStore()` hook at the component level for animated values.

2. **The `<Canvas>` is a portal with its own React tree.** Context providers wrapping your app (i18n, theme, some Zustand setups) are re-entered inside the canvas automatically with R3F v9+, but beware third-party providers that rely on Suspense boundaries. For safety, keep 3D-adjacent UI (speech bubbles, name tags) outside `<Canvas>` as a DOM overlay, positioned via `useThree()` + DOM math — that's also better for accessibility.

3. **VRM loading needs custom plugin registration.** Drei's `useGLTF` doesn't know about VRM. Write a tiny wrapper hook once:
   ```ts
   import { useLoader } from '@react-three/fiber'
   import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
   import { VRMLoaderPlugin } from '@pixiv/three-vrm'
   import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'

   export function useVRMLoader(url: string) {
     return useLoader(GLTFLoader, url, (loader) => {
       loader.register((p) => new VRMLoaderPlugin(p))
       loader.register((p) => new VRMAnimationLoaderPlugin(p))
     })
   }
   ```
   Then `useVRMLoader(url).userData.vrm` is your `VRM` instance. Mount via `<primitive object={vrm.scene} />`. On unmount, call `VRMUtils.deepDispose(vrm.scene)` — drei's loader cache won't do it for you, and VRMs are big.

### 6.5 Observability

Every pipeline stage emits a span:

```ts
interface LatencySpan {
  stage: 'vad' | 'stt' | 'llm-ttft' | 'llm-full' | 'tts-ttfa' | 'tts-chunk' |
         'audio-decode' | 'render-frame' | 'extract-facts'
  turnId: string
  startMs: number
  endMs: number
  metadata?: Record<string, unknown>
}
```

A thin tracer (`src/observability/tracer.ts`) collects these in a ring buffer.
Debug panel (dev-only) shows:
- User-done → first audio latency
- Tokens/second from LLM
- Per-frame cost of each VRM subsystem (like AIRI's `measureFrameStep`)
- Current memory size, compaction history

---

## 7. Project Layout

```
ai-companion/
├── package.json
├── vite.config.ts                      # includes server.proxy for /api/* → :8787
├── tsconfig.json
├── wrangler.toml                       # Cloudflare Workers config (optional, for deploy)
├── .env                                # OPENROUTER_API_KEY, ELEVENLABS_API_KEY (server-side)
├── .env.example
├── index.html
├── server/                             # Hono backend (holds API keys)
│   ├── index.ts                        # app.route('/api/chat', chat), …
│   ├── lib/
│   │   ├── llm.ts                      # createOpenRouter({ apiKey }) + chatModel
│   │   ├── tts.ts                      # ElevenLabs client init
│   │   └── stt.ts                      # ElevenLabs Scribe client init
│   └── routes/
│       ├── chat.ts                     # POST /api/chat → streamText → SSE
│       ├── tts.ts                      # POST /api/tts → ElevenLabs stream
│       ├── stt.ts                      # POST /api/stt → ElevenLabs Scribe
│       └── extract-facts.ts            # POST /api/memory/extract → JSON
├── public/
│   ├── vrm/
│   │   └── aria/                       # one preset for v1; add more as /vrm/<id>/
│   │       ├── model.vrm
│   │       ├── preview.png
│   │       └── animations/
│   │           └── idle.vrma
│   └── lipsync/
│       └── profile.json                # copied from AIRI
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css                       # Tailwind @import "tailwindcss" + @theme
│   ├── i18n/
│   │   ├── index.ts                    # i18next init + browser detector
│   │   └── locales/{en-US,zh-CN}.json
│   ├── types/
│   │   ├── character.ts
│   │   ├── session.ts
│   │   └── memory.ts
│   ├── stores/                         # Zustand stores (with `persist` where apt)
│   │   ├── characters.ts               # character CRUD + active character ID
│   │   ├── sessions.ts                 # chat sessions per character
│   │   ├── settings.ts                 # api keys, device prefs, locales
│   │   └── scene.ts                    # loading state (NOT per-frame values)
│   ├── adapters/                       # thin fetch wrappers around /api/* endpoints
│   │   ├── llm.ts                      # fetch /api/chat (SSE) → typed event stream
│   │   ├── tts.ts                      # fetch /api/tts → AudioBuffer
│   │   └── stt.ts                      # fetch /api/stt → text
│   ├── pipelines/
│   │   ├── turn-controller.ts          # state machine
│   │   ├── speech-pipeline.ts          # TTS queue + playback manager
│   │   ├── tts-chunker.ts
│   │   ├── marker-parser.ts            # <|ACT|> / <|DELAY|>
│   │   └── response-categorizer.ts     # <think> strip
│   ├── memory/
│   │   ├── types.ts
│   │   ├── repo.ts                     # read/write the .md file
│   │   ├── retriever.ts                # build prompt injection block
│   │   ├── extractor.ts                # cheap LLM call → new/reinforced/outdated
│   │   ├── compactor.ts                # background decay + compression
│   │   ├── decay.ts                    # retention + stability formulas
│   │   └── format.ts                   # md serialization
│   ├── hooks/
│   │   ├── useVRMLoader.ts             # GLTF + VRM plugin registration
│   │   ├── useAudioContext.ts          # singleton AudioContext + worklets
│   │   ├── useVAD.ts                   # @ricky0123/vad-web wrapper
│   │   ├── useMarkerStream.ts          # streaming marker parser → React state
│   │   └── useTurn.ts                  # reads turn-controller state reactively
│   ├── vrm/                            # Three.js + VRM components (mount inside <Canvas>)
│   │   ├── Scene.tsx                   # root <Canvas> + lighting + controls
│   │   ├── VRMCharacter.tsx            # loads .vrm, runs useFrame loop
│   │   ├── presets.ts                  # VRM preset registry (see §4.4)
│   │   ├── expression-controller.ts    # emotion state + lerp (plain TS)
│   │   ├── lip-sync-driver.ts          # wlipsync → blendshapes (plain TS)
│   │   ├── idle-life.ts                # blink + saccade + lookAt (plain TS)
│   │   └── animation.ts                # .vrma loading + mixer (plain TS)
│   ├── audio/
│   │   ├── context.ts                  # shared AudioContext + worklet loading
│   │   ├── vad.ts                      # Silero wrapper (plain TS)
│   │   └── playback.ts                 # buffer → source → destination + lipsync
│   ├── observability/
│   │   ├── tracer.ts
│   │   └── DebugPanel.tsx
│   ├── components/                     # DOM React components (outside <Canvas>)
│   │   ├── CharacterPicker.tsx
│   │   ├── ChatHistory.tsx
│   │   ├── MicButton.tsx
│   │   ├── SettingsDrawer.tsx
│   │   └── StartGate.tsx               # AudioContext user-gesture unlock modal
│   └── prompts/
│       ├── system.ts                   # persona + emotions + memory block assembly
│       └── extractor.ts                # memory curator prompt
└── tests/
    ├── memory/
    │   ├── decay.test.ts
    │   └── format.test.ts
    ├── marker-parser.test.ts
    └── response-categorizer.test.ts
```

---

## 8. Implementation Plan (Phased)

Each phase is a shippable checkpoint. Don't move on until the demo works.

### Phase 0 — Bootstrap (1 day)
- `pnpm create vite` → React + TS (SWC) template
- Client deps: `three`, `@pixiv/three-vrm`, `@pixiv/three-vrm-animation`, `@react-three/fiber`, `@react-three/drei`, `tailwindcss@4` + Vite plugin, `zustand`, `react-i18next`, `i18next`, `i18next-browser-languagedetector`
- Server deps: `hono`, `@hono/node-server` (or `hono/cloudflare-workers` adapter), `ai`, `@openrouter/ai-sdk-provider`, `@elevenlabs/elevenlabs-js`
- Dev tooling: `concurrently`, `tsx`, `dotenv`
- Create `server/index.ts` with a stub `/api/health` route; run on `:8787`
- Vite config: `server.proxy['/api']` → `http://localhost:8787`
- Single `pnpm dev` script runs Vite + Hono concurrently
- `.env.example` committed; `.env` git-ignored
- Write `useVRMLoader` hook (§6.4) and a minimal `<VRMCharacter>` component
- Wrap in `<Canvas>` inside `<Suspense>`; render the bundled preset
- **Demo**: character stands in the scene; `curl localhost:5173/api/health` returns 200 (proxied to Hono).

### Phase 1 — Idle life-signs (1 day)
- Load `idle_loop.vrma`, play on `AnimationMixer`
- Blink every 3-6s with jitter
- Eye saccades (small random lookAt drift)
- Spring bones update
- `OrbitControls` for debugging the camera
- **Demo**: character breathes, blinks, glances around. Feels alive.

### Phase 2 — Audio + lip-sync (1 day)
- `src/audio/context.ts`: shared `AudioContext`, loads the resampling worklet
- `src/vrm/lip-sync-driver.ts`: wraps `wlipsync` AudioWorklet
- Debug UI: upload an MP3 → play it → mouth moves
- Verify sample rate: resample to 16k for wlipsync, 48k for destination
- **Demo**: play any audio, watch the mouth match. Critical milestone.

### Phase 3 — TTS + streaming playback (1-1.5 days)
- **Server**: `server/routes/tts.ts` — POST `{ text, voiceId }` → ElevenLabs `@elevenlabs/elevenlabs-js`, `modelId: 'eleven_flash_v2_5'`, `outputFormat: 'pcm_24000'`. Stream raw PCM chunks back in the response body.
- **Client**: `src/adapters/tts.ts` — `fetch('/api/tts', …)`, read body stream, decode to `AudioBuffer`
- `src/pipelines/tts-chunker.ts`: sentence-flush chunker (mirrors AIRI's strategy)
- `src/pipelines/speech-pipeline.ts`: request queue + playback manager, abort-signal-aware (aborts propagate to `fetch`)
- Text input → chunks → `/api/tts` → `AudioBuffer` → playback → lip-sync worklet
- Measure first-audio latency; target <1.0s (adds one proxy hop over direct)
- **Demo**: type a paragraph, character reads it aloud with mouth sync.

### Phase 4 — LLM streaming + marker protocol (2 days)
- **Server**: `server/routes/chat.ts` — POST `{ messages, systemPrompt }` → `streamText({ model: chatModel, messages: [{ role: 'system', content: systemPrompt }, ...messages], abortSignal: c.req.raw.signal })`. Return `result.toDataStreamResponse()` (or `toTextStreamResponse()` for plain SSE).
- **Client**: `src/adapters/llm.ts` — `fetch('/api/chat', { signal })`, read SSE body as an `AsyncIterable<LLMEvent>` with `AbortSignal` knob
- `src/pipelines/marker-parser.ts`: extract `<|ACT:{...}|>` and `<|DELAY:N|>` (streaming-safe, buffered across chunk boundaries)
- `src/pipelines/response-categorizer.ts`: strip `<think>`, `<thinking>`, `<reasoning>`, `<thought>` (defensive — non-reasoning Grok shouldn't emit these, but cheap insurance)
- `src/prompts/system.ts`: persona template with dynamically listed emotions + memory block
- Wire: user input → `/api/chat` → marker parser → (literals → chunker → TTS; specials → ACT queue)
- `src/vrm/expression-controller.ts`: consume ACT queue, lerp emotions with 3s decay to neutral
- **Demo**: chat with the character. It speaks, emotes, and stays in character.

### Phase 5 — Mic + STT + barge-in (2 days)
- **Server**: `server/routes/stt.ts` — POST `{ audio: blob, language }` (multipart) → ElevenLabs Scribe `speechToText.convert(…)` → `{ text }`
- **Client**: `src/audio/vad.ts` — Silero (`@ricky0123/vad-web`) wrapper, emits `speech-start` / `speech-end`
- **Client**: `src/adapters/stt.ts` — capture VAD-segmented audio into a WebM/Opus blob, POST to `/api/stt`, return transcript
- `src/pipelines/turn-controller.ts`: the state machine in §6.1
- Barge-in: VAD `speech-start` during SPEAKING → abort TTS + LLM `fetch`es (via their `AbortController`) + flush emotion queue
- Audio ducking on speech-start (500ms grace; if persistent, full cut)
- Push-to-talk button as alternative trigger
- Partial-message persistence: truncate the assistant's reply in history with `[interrupted]` marker
- **Demo**: full-duplex conversation with interruption.

### Phase 6 — Character system (1 day)
- `src/vrm/presets.ts`: registry with one bundled preset (see §4.4). Wire `VRMCharacter` to load by `presetId`, not URL
- `src/stores/characters.ts`: Zustand store with `persist` middleware (IndexedDB via `unstorage` or `idb-keyval`)
- `src/components/CharacterPicker.tsx`: dropdown + "new character", "edit", "delete". Character edit form has a **VRM preset picker** (thumbnail list) — no upload UI
- `src/stores/scene.ts`: loading state machine (`pending` → `loading` → `binding` → `ready`)
- Switching character: dispose current VRM (`VRMUtils.deepDispose`), load new preset, rebind TTS voice, swap system prompt, load that character's session
- Bundle one built-in character mapped to the one bundled preset
- **Demo**: create a second character with the same preset but a different voice and persona; switch between them instantly.

### Phase 7 — Memory system (3-4 days) ← the novel piece
- **Server**: `server/routes/extract-facts.ts` — POST `{ lastUserTurn, lastAssistantTurn, retrievedFacts }` → calls the same `chatModel` with structured-output schema (Zod) → returns `{ new_facts, reinforced_fact_ids, outdated_fact_ids }` JSON
- **Client** — `src/memory/types.ts`, `format.ts`: markdown serde
- **Client** — `src/memory/repo.ts`: read-modify-write of the `.md` file in IndexedDB (single tab; cross-tab locks via `BroadcastChannel` if needed)
- **Client** — `src/memory/decay.ts`: retention + stability formulas, unit-tested
- **Client** — `src/memory/retriever.ts`: build injection block for system prompt
- **Client** — `src/memory/extractor.ts`: async call to `/api/memory/extract` after each assistant turn; queue + retry; applies results via `repo`
- **Client** — `src/memory/compactor.ts`: background task (on idle, or every 50 turns); for facts whose retention < 0.2, POST `/api/memory/extract` with a compaction prompt variant and bump compression level; delete L3 facts with retention < 0.05
- `src/prompts/system.ts`: include memory block
- Debug view: memory inspector (show fact list with retention + compression level + access count)
- Tests: unit-test decay curve; integration-test extract → inject → retrieve round-trip
- **Demo**: tell the character your name, close the tab, reopen next day, it greets you by name. Tell it something trivial, ask 3 days later, it only vaguely remembers.

### Phase 8 — Observability (0.5 day)
- `src/observability/tracer.ts`: ring buffer of `LatencySpan`s
- `src/observability/DebugPanel.tsx`: overlays last-turn latency breakdown + current fps + per-subsystem frame cost
- Dev-only flag (`import.meta.env.DEV`); production builds strip it
- **Demo**: open debug panel, see "mic→first audio = 1340ms" broken into stages.

### Phase 9 — i18n (1 day)
- `react-i18next` + `i18next` + `i18next-browser-languagedetector` with `en-US` and `zh-CN` locales
- Character struct: per-locale prompts + greetings
- Settings: app language × character language × TTS voice language (three independent dropdowns)
- System prompt template localized (instructional content) while persona stays in character's primary language
- Test: character with `zh-CN` locale + Mandarin TTS voice speaking Mandarin to an EN-US UI works
- **Demo**: switch UI to 简体中文; pick a Chinese-speaking character; have a conversation in Chinese.

### Phase 10 — Cold-start polish (0.5-1 day)
- Loading state machine in `src/stores/scene.ts`: `idle → initializing-audio → loading-vrm (%) → binding → ready`
- `<StartGate>` modal for user-gesture-gated `AudioContext.resume()` ("click to start")
- Progress bar during VRM load
- Graceful degradation: if TTS fails, show text but don't block; if mic denied, fall back to text input; if VRM fails, show a placeholder
- **Demo**: first-time user hits the page, gets a clear "click to start" affordance, sees progress during model load, can chat within 5 seconds.

### Total estimate
**~2.5 weeks of focused work** for a polished v1. Phases 0-5 (~1 week) gets you a talking, lip-syncing, interruptible companion. Phase 7 (memory) is the distinctive feature. Phases 8-10 are the polish.

---

## 9. Key Files to Reference from AIRI

When in doubt, read these (paths relative to your AIRI clone at `/Users/chen/projects/playground/airi/`):

| Topic | File |
|---|---|
| VRM loading + render loop | `packages/stage-ui-three/src/components/Model/VRMModel.vue` |
| VRM emotion state machine | `packages/stage-ui-three/src/composables/vrm/expression.ts` |
| Lip-sync wlipsync integration | `packages/stage-ui-three/src/composables/vrm/lip-sync.ts` |
| .vrma loading + blink + saccade | `packages/stage-ui-three/src/composables/vrm/animation.ts` |
| Inline marker parser | `packages/stage-ui/src/composables/llm-marker-parser.ts` |
| Response categorizer (`<think>` strip) | `packages/stage-ui/src/composables/response-categoriser.ts` |
| TTS chunker | `packages/stage-ui/src/utils/tts.ts` |
| Speech pipeline (queue + priority) | `packages/pipelines-audio/src/speech-pipeline.ts` |
| Stream-text wrapper | `packages/core-agent/src/runtime/llm-service.ts` |
| System prompt template | `packages/stage-ui/src/constants/prompts/system-v2.ts` |
| Emotion enum + VRM mapping | `packages/stage-ui/src/constants/emotions.ts` |
| Character schema | `packages/stage-ui/src/types/character.ts` |
| Character activation + binding | `packages/stage-ui/src/stores/modules/airi-card.ts` |
| Session storage repo | `packages/stage-ui/src/database/repos/chat-sessions.repo.ts` |
| Audio context + worklets | `packages/audio/src/audio-context/index.ts` |

---

## 10. Risks & Unknowns

| Risk | Mitigation |
|---|---|
| Sample-rate mismatch silently breaks lip-sync | Lock in resampling worklet in Phase 2; write a golden-audio integration test |
| First-audio latency > 2s with ElevenLabs Flash | Measure in Phase 3; add Kokoro-js local fallback path early |
| Memory extractor produces noisy facts | Prompt engineering + manual testing; importance threshold of 0.3 filters most noise; debug inspector lets you tune |
| Memory compaction destroys useful detail | Keep raw messages forever (they're cheap); memory facts are derived and rebuildable. Also: log every compaction in a `memory-history.md` so you can audit |
| Barge-in false positives (user cough, TV in background) | 500ms grace window; confidence threshold on VAD; optional push-to-talk mode as override |
| VRM model load time (30-100MB) | Show progress; cache in Cache API keyed by URL hash; bundle a small default for first run |
| AudioContext gating on user gesture blocks autoplay | Single "Start" modal on first visit; afterward context stays resumed |
| **API keys leaking to clients** | Keys live only in server env vars (`OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`); client only knows `/api/*` endpoints. Never prefix with `VITE_`. CI check: grep-fail on any `VITE_.*_API_KEY` occurrence. |
| **Server proxy adds a hop** | First-audio and first-token latency increase by ~50-150ms vs. direct calls. Mitigate by deploying server close to users (Cloudflare Workers is global edge; Vercel Edge similar). |
| Provider lock-in | TTS/STT behind adapters; LLM hardcoded but isolated in `server/lib/llm.ts` — swap each in ~1 hour |
| wlipsync profile is tuned for Japanese phonemes | Works well for English/Chinese anecdotally (AIRI ships it globally). Monitor. Can train a new profile if needed (the library supports it) |
| Memory file conflict across tabs | Lock via `BroadcastChannel` + last-write-wins with warning; realistically: one tab per user |
| React re-renders at 60fps will kill performance | Keep all per-frame VRM state in `useRef`; read Zustand imperatively via `useStore.getState()` inside `useFrame`, never via the hook for animated values |
| ElevenLabs STT HTTP endpoint adds ~500ms-1s to turn | Acceptable for v1. If pained, switch to their realtime WebSocket STT, or swap the adapter for local Whisper via `@xenova/transformers` |
| Single-vendor dependency on ElevenLabs | TTS + STT both behind adapters; OpenAI TTS / Whisper are drop-in replacements within a day |
| **Single LLM for both conversation and memory** | An xAI outage takes down everything. Mitigate with a "degraded mode" flag that skips memory extraction if the curator call fails for N consecutive turns; conversation itself continues |
| **xAI rate limits apply to both paths** | Monitor combined RPM; curator can be batched to run every N turns rather than every turn if needed |
| Small preset VRM catalog limits personalization | Acceptable for v1. Schema is already shaped around preset IDs so adding user uploads later is additive — not a migration |

---

## 11. Resolved Decisions

All previously open questions have been locked in:

| Question | Decision |
|---|---|
| LLM provider for conversation | **Hardcoded** to `xai/grok-4.1-fast-non-reasoning` routed through **OpenRouter** (via `@openrouter/ai-sdk-provider`). Key lives in server env only. No user-facing picker, no client-side key. |
| Bundled VRM | **Yes.** Preset registry under `/public/vrm/`; one preset for v1, room for 2-3. No user upload. |
| Memory curator model | **Same as conversation** — `xai/grok-4.1-fast-non-reasoning`. Single API key, single billing line. |
| Target languages | **en-US and zh-CN** for v1. `Locale` type is narrowed accordingly; extendable later. |
| Tool calls / MCP | **Out of scope.** No tool-call handling in `llm.ts`; `ChatMessage.role` is `'system' \| 'user' \| 'assistant'` only. |
| Desktop (Electron) | **Out of scope.** Web-only for v1. |

---

## 12. Definition of Done for v1

- [ ] Character loads, breathes, blinks, saccades.
- [ ] I can type at it and it replies in voice with matching mouth and expressions.
- [ ] I can talk to it via mic; it transcribes, replies, and I can interrupt it.
- [ ] Multiple characters exist; I can switch between them.
- [ ] It remembers my name across a page reload.
- [ ] It forgets a throwaway comment from a week ago but remembers that I dislike cilantro from last month.
- [ ] First audio arrives within 1.2s of user-done-speaking (p50).
- [ ] 60fps render while speaking on an M1 Mac.
- [ ] UI and speech work in both en-US and zh-CN.
- [ ] Debug panel shows latency breakdown per turn.
- [ ] A fresh visitor can have a working conversation within 10 seconds of opening the page.
