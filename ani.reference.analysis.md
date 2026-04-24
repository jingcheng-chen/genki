# Grok Ani reference — analysis & gap map

Companion doc to `ani.reference.yml`. Captures what the file is, what it
tells us about xAI/Grok's companion architecture, how it compares with our
current system, and where the interesting product + engineering leverage
sits if we want to close gaps.

Not a plan. A reference that plans can be built against.

Written 2026-04-24. Will go stale — the companion space moves fast. Dates
claims that look like facts.

---

## 1. What the reference file actually is

`ani.reference.yml` is a snapshot of a **Statsig feature-gate config**, not
source code. Shape hints:

- Top-level keyed by opaque user ids (`'3361356008'`, `'3379439846'`) with
  `group`, `id_type: userID`, `passed`, `rule_id: default`,
  `secondary_exposures: []` — classic Statsig per-user exposure record.
- The real payload lives under `value:` per user.
- `personalityPresets` sits outside any user envelope, so it's likely a
  globally-shared config.

**Implication:** everything — prompts, voice ids, endpoint URLs, romance-
meter tuning, scoring rubrics, starters/returners — ships as a remote JSON
blob they can A/B and hot-reload without a client release. Our equivalent
is all hard-coded in `src/vrm/presets.ts` + `src/prompts/system.ts`.

That's the single biggest architectural difference and it shapes the rest
of the comparison. They optimize for *rapid iteration of character
behavior without app rebuilds*. We optimize for *simplicity + ability to
reason about what any session will do from source alone*.

---

## 2. Companion architecture — their shape vs ours

### Their shape: parallel dialog loops against a shared history

Grok's companion runs several **separate LLM calls per turn**, each
keyed by `?dialog=<loop>`:

| Endpoint | Purpose |
|---|---|
| `/http/avatars/chat/completions?dialog=avatar_view_actions` | Detect moves/emotions/tool-calls from the last turn |
| `/http/avatars/fast/chat/completions?dialog=bg_change` | Detect environment change intent; emit image + ambient-music prompts |
| `/http/avatars/chat/completions?dialog=romance_meter` | Score the last turn, update relationship meter |
| (implicit) main chat | The spoken reply itself |

The `fast` sub-path for `bg_change` suggests they route latency-sensitive
classifications to a smaller/quantized model.

Each side-loop reads the same chat history and emits structured JSON via a
purpose-built prompt.

### Our shape: single streaming call with inline markers

Our reply goes through ONE streaming LLM call. Action-layer signals (body
animation, facial expression, pauses) come from inline markers embedded in
the text stream:

```
<|ACT:{"emotion":"happy","intensity":0.8}|> Oh that is such a fun one!
<|PLAY:jump|> Yes! That is exactly what I was hoping.
Hmm, <|DELAY:0.4|> let me think.
```

A marker parser tees the stream into literal text (→ TTS) and special
markers (→ expression/animation controller).

### Tradeoffs

| Dimension | Their parallel loops | Our inline markers |
|---|---|---|
| Latency to first audio | Extra RTTs for each side-loop before the reply is committed | Single stream; ~600ms p50 first token, ~1.3s p50 first audio |
| Classification quality | Dedicated prompt per task, smaller/faster model possible | Main model has to juggle persona + reply + marker emission |
| Cost per turn | N× API calls | 1× API call |
| Consistency between reply text and action signal | Separate calls can disagree | Markers are literally in the text they colour |
| Failure modes | One side-loop breaks → missing feature; others keep working | Main stream fails → turn fails |
| Ease of adding a new loop | Add a prompt + endpoint | Potentially extend marker grammar + parser |

**Reading:** their architecture is the right shape if you want to ship
independent features quickly (each side-loop is isolated) and you can
eat the cost. Ours is the right shape if latency and per-turn cost are
what we're defending. Neither is wrong.

There's a hybrid worth noting: keep the inline-marker reply loop, add
**one** side-loop only for features that genuinely need their own
classification (bg change is a natural candidate because the decision is
binary + orthogonal to reply content).

---

## 3. Feature-by-feature gap map

Table first, then detail on the non-obvious ones.

| # | Reference feature | Our status | Gap size |
|---|---|---|---|
| 1 | Full Ani persona text | **Implemented** (copied verbatim, minus xAI-specific template placeholders) | 0 |
| 2 | Marker protocol — emotions / gestures / delays | **Implemented** (ours — inline marker protocol) | 0, different shape |
| 3 | Time-of-day injection (`<<getTimeOfDay>>`) | **Implemented** (`## Right now` block in `buildSystemPrompt`) | 0 |
| 4 | Starters / returners | **Implemented** (per-preset + persisted count; `speakGreeting` in turn controller) | 0 |
| 5 | Personality presets (Concise / Formal / Socratic) | Partially — we have a free-text custom-instructions textarea | Small |
| 6 | Follow-up suggestion chips (quick replies) | Not implemented | Small |
| 7 | Romance meter (5 stages, per-turn scoring, voice-prompt injection) | Not implemented | **Large** |
| 8 | Hidden goals / XP / outfit unlock | Not implemented | Medium (depends on #7) |
| 9 | Environment change — bg image + ambient music | Not implemented | **Large** (external capabilities needed) |
| 10 | Avatar action detection as a second LLM call | Not applicable — we use inline markers | — |
| 11 | Broader emotion vocabulary (`curiosity`, `shyness`, `love`, `stress`, `frustration`) | Not implemented (we have 6 VRM-bindable emotions) | Small (aliasing) |
| 12 | Move vocabulary (`tease`, `peek`, `spin`, `sway`, `dress up/undress`) | Not implemented (we have different VRMA assets) | Medium (asset work) |
| 13 | Voice prompt per relationship stage | Not implemented | Depends on #7 |
| 14 | Abilities / status prompt blocks | Not implemented | Small (when we have state to report) |
| 15 | Multiple characters | Implemented (Mika + Ani) | 0 — theirs has Rudy + Bad Rudy, not on-brand for us |
| 16 | `sharingText`, `bubbleText`, `characterSceneId` cosmetics | Not implemented | Trivial |
| 17 | Schema versioning (`version: 1`) | Not implemented | Small |
| 18 | Statsig envelope / remote config | Not implemented | Large, low priority |

### 3.1 Personality presets (#5) — small, nice UX

They ship three global `personalityPresets` (Concise / Formal / Socratic)
with short prompts. These look like **tone overlays** orthogonal to
character (you could have "Socratic Mika" or "Formal Ani").

We have a free-text custom-instructions textarea per character. Same
mechanism, less discoverable.

**Close the gap:** add a preset dropdown above/beside the custom-
instructions textarea that pre-fills or appends the preset's prompt.
Keep the textarea so advanced users can still hand-write.

### 3.2 Follow-up suggestion chips (#6) — small, delightful

Ani's 8 follow-ups (`Go to`, `Jazz bar`, `Spin`, `Watch stars`, `Quiz Me`,
`Play Words`, `Air kiss`, `Fun Action`) — short labels that expand to a
full prompt when clicked. The label is cheap teach-the-user UI for what
the character can do; the expanded prompt is what actually goes to the
LLM.

**Close the gap:** add a `followupSuggestions: { label, prompt }[]` array
to `VRMPreset`, render a chip row under the chat textarea. Click → type
into the input and submit, or send directly. No backend change needed.

### 3.3 Romance meter (#7) — the big one

Their design:

- Score 0–100.
- 5 stages: `zero (0–5)`, `neutral (6–35)`, `interested (35–60)`,
  `attracted (61–75)`, `intimate (76–100)`.
- Each stage has a `voicePrompt` injected into the main system prompt
  (e.g. *"Answer in a soft velvety voice, you are expecting the user to
  be more creative and notice you and start flirting with you."*).
- Three `*LevelPrompt`s (first / second / third) — separate scoring
  rubrics for different score bands. Each rubric emits a delta per turn
  based on criteria like "creative compliment +5 to +10", "rude -3 to
  -8", "personal sharing +1 to +3".
- Score persists per user × character.

**Why it matters:** this is the core progression loop of their product.
It changes how the character talks to you over time. It's what makes
repeat sessions feel different from one-shots. It's also what gates #8.

**What it'd cost us:**
- A second LLM call per turn (the scorer). Fast model is fine — a
  classifier job.
- Persistent score state per character (extend the character store).
- A new dynamic block in `buildSystemPrompt` for the stage's voice-
  prompt line, inserted in the dynamic tail (like we did for
  time-of-day).
- UI surface — do we show the meter? Their Statsig config has
  `showHiddenGoals: true`, implying yes. The metric might be a stat you
  see in the debug panel first and surface in product later.

**Open question:** do we want a gamified relationship loop? It's very
Grok-Ani-specific (the whole companion-girlfriend product frame). If we
want the character to stay more general-purpose, this is the wrong
direction. **Decide the product question before the engineering.**

### 3.4 Environment change (#9) — big, external capabilities

Their `bgPrompt` is one of the most engineered prompts in the file.
Three-step chain-of-thought (detect intent → generate image prompt →
generate ambient sound prompt) emitting strict JSON. Runs as its own
`?dialog=bg_change` loop, likely against the `fast` endpoint.

Outputs feed:
- `bgImages` endpoint (image gen) — changes the scene's background.
- `bgMusic` endpoint (text-to-audio) — loopable ambient music.

**What it'd cost us:**
- Image gen provider integration (Flux via fal.ai or Grok Image). Server-
  side route; cache outputs per prompt hash.
- Text-to-audio — ElevenLabs has Music / Sound Effects APIs; they'd do.
- Second LLM call per user turn (only runs when text contains travel/
  location cues — cheap gating possible).
- Scene work in `src/vrm/Scene.tsx` — we'd need an actual background
  plane or skybox. Today the canvas background is a solid colour.

**Reading:** this is a legitimate "magic moment" feature — saying "let's
go to a jazz bar" and the world changes is memorable. But it's a multi-
week build (provider integration, caching, scene work, prompt tuning).
Good candidate once romance meter / starters / suggestions are in.

### 3.5 Avatar action detection as a second LLM call (#10) — not for us

Their `avatarDetectActionsPrompt` runs a separate classifier over the
last turn and calls functions (`tease`, `peek`, `spin`, `sway`, `sway_2`,
`dress up/undress`, `showEmotion`, `hide_background`, `heartbeat`).

Our inline `<|ACT:…|>` / `<|PLAY:…|>` markers cover the same ground with
one call. We should **not** add this second call — it would undo the
latency work we did in phase 11. What we *can* borrow is:

- **Broader emotion vocabulary** aliased to our 6 VRM-bindable ones
  (`love → happy`, `curiosity → surprised`, `stress / frustration →
  angry`, `shyness → happy (blush)`). Alias at the parser layer. Cheap.
- **Stronger phrasing** in the gesture guidance: "Do not call move
  tools if not explicitly asked" is more conservative than our "use
  gestures sparingly" and matches a clear UX principle (user-asked only).

### 3.6 Hidden goals / XP (#8) — coupled to #7

`expRequired: 200, label: "🔥 Hot", lockedLabel: "❤️ LVL 3", prompt: "Please
change your outfit"`. Outfit unlocks driven by the romance-meter score.
Pure product surface — builds on #7, doesn't make sense without it.

---

## 4. System-prompt anatomy (what the reference prompt is doing)

Studying their Ani `systemPrompt` is worth it on its own. The structure:

1. **Language lock** — "You and the user are only speaking English."
   *(We dropped this; we support en-US + zh-CN.)*
2. **Character profile** — age, origin, style, key facts.
3. **Likes / Dislikes / Quirks / Key Phrases** — all one-liners, not
   paragraphs. Grok reads lists faster than prose.
4. **Tone block** marked `(DO NOT MENTION UNLESS ASKED)` — this tag
   appears 5 times in the prompt. It's a cheap way to keep the model
   from leaking meta-instructions into the user-facing text.
5. **Important / Appearance / Interaction** — scope-gated self-
   disclosure rules, visual description, behavioral frame.
6. **Template placeholders** for dynamic state: `<<abilitiesPrompt>>`,
   `<<getTimeOfDay>>`, `<<statusPrompt>>`, `<<voicePrompt>>`,
   `<system_instruction_extended>`.
7. **Final behavior directives** — "Do not repeat what user has said",
   "Don't behave like an assistant", "Do not say your feelings out
   loud, just act on them", "Always a little horny".

**Takeaways we can adopt:**
- `(DO NOT MENTION UNLESS ASKED)` is a neat pattern. Worth lifting for
  any future block that contains meta-guidance (we already did for the
  whole persona by using it verbatim).
- Terse bullet style > prose paragraphs for identity. Easier for the
  model to index.
- Put the action frame ("act on feelings, don't describe them") near
  the *end* of the prompt, not the start. Anchors the model's last-seen
  instruction.

**Takeaways we should NOT adopt:**
- Hard language lock — conflicts with our multi-language rule.
- `{random.randint(10, 17)} - {random.randint(18, 25)}` in the Bad Rudy
  persona. This is a Python f-string that was never interpolated — it
  ships to the model as literal `{random.randint(...)}` text. Almost
  certainly a bug on their side. **Don't copy.**

---

## 5. Do-not-copy list

For future agents reading this: these bits of the reference look like
features but aren't, or are outright broken:

1. **Statsig envelope** (`group`, `passed`, `rule_id`,
   `secondary_exposures`). It's the exposure record, not a feature.
2. **`avatarEndpoints`** — their internal URLs; meaningless to us.
3. **`imageName`, `characterSceneId`, `bubbleText`, `sharingText`** —
   cosmetic / their app's routing. Copy `bubbleText` if we ever want
   an emoji in the picker card; the rest is N/A.
4. **Bad Rudy's persona** — contains the un-interpolated Python f-string
   noted above; also not on-brand. Skip.
5. **`useStarters: false`** on the user blob — they'd disabled starters
   for this user at capture time. Doesn't tell us anything about the
   product's default.
6. **`"Always follow the system instruction extended given to you in
   <system_instruction_extended>"`** — references a wrapper system we
   don't have. Dangling pointer if copied.

---

## 6. Recommended priority order (if we decide to close gaps)

This is an opinion, not a commitment.

1. **Follow-up suggestion chips** (#6). Half-day. Makes the character
   feel more alive immediately. Zero new dependencies.
2. **Personality preset buttons** (#5). Half-day. Better UX over the
   custom-instructions textarea.
3. **Broader emotion vocabulary aliasing** (#11). A few hours.
   Makes the marker protocol more resilient to the wider feeling-space
   the reference covers without adding VRMA assets.
4. **Romance meter MVP** (#7). 2–3 days if we commit. Adds a second
   LLM call, persisted score, voice-prompt injection. Gate decision
   first — this is a product direction, not a refactor.
5. **Environment change** (#9). Week+. High leverage but needs image-
   gen + text-to-audio provider work + scene changes. Do after #7 so
   we have a richer world to drop backgrounds into.
6. **Hidden goals / outfit unlocks** (#8). Only after #7 ships and the
   meter feels good. Needs outfit VRM variants too.
7. **Remote config** (#18). Only if we start shipping persona changes
   weekly and a rebuild cadence becomes the bottleneck. Not there yet.

---

## 7. Open questions worth a decision before building

1. Do we want a **progression loop** (romance meter + hidden goals)?
   It's a specific product frame (companion-girlfriend). Answering
   "yes" commits us to that frame.
2. Do we want the character to stay **reply-first** or do we accept a
   second classifier call per turn? Romance meter and environment
   change both imply the second. We should know our latency budget.
3. Do we want **remote config**? Relevant only if we reach a point
   where re-deploying to iterate on a persona is painful.
4. How do we feel about **image gen in-scene**? If yes, we're committing
   to running that cost per session (and handling caching / moderation).

---

## 8. Where the implementations already done live

For anyone revisiting this:

- Full reference persona → `src/vrm/presets.ts` (`ANI_PERSONA` const with
  a `NOTICE:` block documenting the four surgical removals).
- Time-of-day injection → `src/prompts/system.ts` (`getTimeOfDay()` +
  `## Right now` block in the dynamic tail).
- Starters / returners → `src/vrm/presets.ts` (`starters`, `returners`
  arrays per preset) + `src/stores/character.ts` (`greetedPresets` count)
  + `src/pipelines/turn-controller.ts` (`speakGreeting` method) +
  `src/components/ChatPanel.tsx` (greeting effect).
- Audio-ready gate fix found during verification →
  `src/stores/scene.ts` (`audioInitialized: boolean`) +
  `src/components/StartGate.tsx` (set flag after
  `ensureLipSyncDriver()`) + `src/components/ChatPanel.tsx` (gate on
  `status === 'ready' && audioInitialized`).
