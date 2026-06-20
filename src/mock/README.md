# Mock-mode harness — developer guide

`npm run mock` runs the **real, unmodified frontend** in a plain browser against a fake Tauri layer:
no Rust backend, no sidecar, no agent, **zero LLM tokens**. It exists for fast visual QA of every
distinct UI state. This guide is for maintainers of the harness itself. User-facing overview lives in
the repo `README.md` → "Mock mode"; the contract surface it mirrors is in `CONTRACT.md`.

> **Hard rule:** the harness lives entirely under `src/mock/**` plus `vite.mock.config.ts` and a single
> `package.json` `"mock"` script. It NEVER modifies production source (`src/main.ts`,
> `src/conversation/**`, `src/render/**`, `vite.config.ts`, `index.html`, `src/types.ts`). The whole
> point is that the app code is byte-identical to production — only its IPC resolution targets differ.

## Architecture

```
npm run mock
  └─ vite.mock.config.ts        merges onto vite.config.ts; aliases @tauri-apps/* → src/mock/* shims;
                                injects <script src="/src/mock/deck.ts"> before </body>; port 1421
       ├─ core.ts               shim for @tauri-apps/api/core  → invoke(cmd, args)
       ├─ event.ts              shim for @tauri-apps/api/event → listen/once/emit + replay-on-subscribe bus
       ├─ path.ts window.ts opener.ts dialog.ts   thin shims for the other @tauri-apps specifiers
       ├─ state.ts              the in-memory store (plans, markdown, reviews, auth, activeScene, knobs)
       ├─ orchestrator.ts       a fake getOrchestrator() singleton (gate snapshots, no real SDK)
       ├─ fixtures/             hand-authored data: scenes.ts, plans.ts, markdown.ts, questions.ts,
       │                        reviews.ts, transcripts.ts
       ├─ player.ts             turns a scene's SceneFrame[] into model inputs (live bus AND test-direct)
       ├─ api.ts                window.__mock: the jumpers (playScene/showReview/openDoc/reset/…)
       ├─ deck.ts               the floating control panel (presets + knobs); installs the orchestrator
       │                        + window.__mock; mounts on DOM ready
       └─ knobs.ts              the live-knob registry (def + apply(value) per knob)
```

**The alias seam (`vite.mock.config.ts`).** Object-form `resolve.alias` with exact keys for each
`@tauri-apps/*` specifier the app imports (derived by grepping `from "@tauri-apps` across `src/`). The
matching real packages are excluded from dep pre-bundling so esbuild can't bypass the alias. The config
imports `vite.config.ts` and merges onto it, so vitest keeps reading the base config untouched.

**Boot order (`deck.ts`).** On module eval it installs the fake orchestrator + `window.__mock`
*immediately* (before DOM ready) so a scene can be staged before `main.ts`'s `DOMContentLoaded` wiring
calls `getOrchestrator().subscribe(...)`. It mounts the panel on DOM ready, then (deferred one frame
past the app's own DOMContentLoaded) either replays a pending URL conversation jump or stages a default
scene.

**The event bus (`event.ts`) — replay-on-subscribe.** `emitMockEvent(name, payload)` buffers per name
AND fans out to current handlers; a `listen(name, …)` replays the existing buffer to the new handler.
This defeats the boot race where a frame is staged before `initConversation`'s async listeners attach.
A scene load clears the agent buffers FIRST (`clearAgentBuffers` in `player.ts`) so a switched-to scene
never replays the previous scene's frames to a later subscriber.

## How to ADD a conversation scene

1. **Builder** — add a `SceneBuilder` to `src/mock/fixtures/scenes.ts`. Build each frame from the real
   typed shapes via the `stream(...)` / `permission(...)` constructors (so a `types.ts` field rename is
   a compile error here). Return frames in strict `seq` order.
2. **Registry** — add it to the `SCENES` object (the `as const satisfies Record<string, SceneBuilder>`
   gives it a `SceneName`). `SCENE_NAMES`, `listScenes()`, and the deck's conversation-preset row all
   derive from `SCENES`, so it appears automatically.
3. **Label (optional)** — add a human label in `deck.ts`'s `SCENE_LABELS` (falls back to the raw name).
4. **Signature test** — add the scene's signature selector to the `SIGNATURE` map in
   `src/mock/scenes.test.ts`. The per-scene loop renders it through the REAL model + `renderTree` and
   asserts the selector is present. **Add a falsifiability assertion** if the scene introduces a new key
   frame (drop that frame → the signature must disappear), matching the existing `FALSIFY:` tests.
5. **Exhaustiveness** — if the scene drives a NEW `AgentStream` kind, the union exhaustiveness guard in
   `scenes.test.ts` (`COVERAGE` map) will already account for it via the runtime derivation; if the kind
   was previously `"uncovered"`, flip its `COVERAGE` entry to `"scene"` and drop it from
   `KNOWN_UNCOVERED`.

> Every channel a scene frame targets (`SceneEvent`) MUST map to a REAL Tauri event the conversation
> domain subscribes to, so a deck preset's live behavior always matches its model-direct test path.
> Do not add a synthetic "no wire route" channel — a scene that renders nothing live while its test
> passes is exactly the divergence the harness was cleaned up to remove. (The `.conv-notice` row, for
> instance, is reachable ONLY via the controller's private `surfaceMessage` handle, which the mock
> cannot reach without editing production source — so there is no `notice` scene.)

## How to ADD a knob

Add a `Knob` to the `KNOBS` array in `src/mock/knobs.ts`:

```ts
{ id: "group.name", group: "Conversation", label: "…", kind: "select",
  options: [{ value: "a", label: "A" }], default: "a",
  apply(value) { /* re-drive ONLY the affected surface through a REAL production seam */ } }
```

- `kind` is `toggle | select | number | text`; the deck renders the right control automatically and
  wires `apply(value)` to it.
- `group` is a `KnobGroup` (`Global | Sidebar | Reading pane | Conversation | Question card |
  Review bar | Modals`); the deck groups controls by it, preserving first-appearance order.
- `apply` MUST drive the real seam (click the real toggle, dispatch a real `input` event, emit a real
  `plan-changed`, call a `window.__mock.*` jumper) — never reach into production internals or render
  DOM directly. Idempotency is expected (the deck re-applies restored Global/Sidebar knobs on a
  conversation-jump reload).

`knobs.test.ts` covers the registry + drivers; add a test there for a non-trivial driver.

## How to ADD a Tauri command handler

When production starts invoking a NEW command, the **registry canary** (`registry-canary.test.ts`) goes
RED until the mock handles it. To add a handler:

1. Add a `dispatch` case in `src/mock/core.ts` returning a shaped value (boot-critical) or `undefined`
   (fire-and-forget). An unknown command warns + returns `undefined` (never throws), but the canary
   still fails until it is explicitly handled.
2. Add the command name to the `MockCommand` union (documents the arg shape) AND to the
   `HANDLED_COMMANDS` array (`as const satisfies readonly MockCommand["cmd"][]` — so the two stay in
   lockstep). `HANDLED_COMMAND_SET` (the canary's superset target) derives from it.

`tsc` does NOT link the app's untyped `invoke(cmd, args)` call sites to `MockCommand`; the canary is
what couples the mock's handled surface to the app's real call sites at test time.

## Load-bearing fidelity assumptions (keep these true)

These are the invariants that make the mock a faithful stand-in. Breaking one silently makes the
harness lie about real behavior.

- **Frames match the real `AgentStream` union.** Scene/handler frames are typed against
  `src/conversation/types.ts`, so `tsc --noEmit` over `src/mock/**` catches render-data drift. The
  exhaustiveness guard in `scenes.test.ts` additionally forces a conscious classification of every union
  member (the `KNOWN_UNCOVERED` allowlist: `status`, `permission_denied`, `resume_fallback`).
- **Gate shapes match the real orchestrator.** The fake `orchestrator.ts` emits the SAME snapshot shape
  `main.ts`'s subscribed observer consumes (prototype/acceptance gate). The mock never registers a real
  orchestration, so `isOrchestrationActive()` is false — which is WHY the in-process review path (and
  the ExitPlanMode write→open round-trip) runs in mock mode.
- **Permission frames are seq-less.** The real sidecar emits `tool_permission_requested` with NO `seq`
  (`sidecar/permissions.ts`), and the controller passes it straight to `appendPermissionRequest`. The
  `permission(...)` constructor takes the `Omit<…, "seq">` shape; do not fabricate a `seq` (it would
  break the `lastWireSeq + 0.5` ordering of a following user echo).
- **`write_agent_plan` → `read_plan_contents` round-trips.** The in-process review flow calls
  `write_agent_plan({ plan })` then opens the RETURNED path via `read_plan_contents`. `core.ts`
  registers the plan text at a deterministic written path and returns it, so the Plan tab shows the
  exact plan, not a fallback. Keep this round-trip intact.
- **The conversation-jump reload reset.** The live `ConversationModel` is a private closure with no
  production in-place reset, so the ONLY faithful way to get a clean live stream is a fresh page load.
  Conversation jumps therefore write the target to the URL (`?mockjump=…`) and reload; the deck replays
  it into the fresh post-reload model. Non-conversation surfaces (review bar, resume, reading-pane,
  composer) DO have reachable production teardown and are reset in place. Tests bypass the reload via the
  `window.__mockNoReload` escape hatch (jsdom cannot reload) and assert cleanliness against a freshly
  constructed model — the same end state the reload produces.

## Tests

```sh
npx vitest run src/mock/      # the harness's own suite (scenes, knobs, reviews, reset, canary)
npx tsc --noEmit              # render-data drift in the typed fixtures
```

- `scenes.test.ts` — per-scene signature (+ falsifiability), scene-switch buffer-scoping, question-card
  round-trip, and the `AgentStream` exhaustiveness guard.
- `registry-canary.test.ts` — the command-registry drift canary (above).
- `knobs.test.ts` / `reviews.test.ts` / `reset.test.ts` — the deck knobs, review-bar drivers, and the
  order-independent `reset()` seam.
