// Mock-ANIMATE reconciler tests (jsdom + spies). The reconciler drives the REAL host seams to the
// FULL projected state at scrub time T. These tests inject SPY seams so each assertion is about WHICH
// seam fired (and how often), not about real DOM painting — the production seams are integration-tested
// elsewhere. The invariants asserted (each falsifiable):
//
//   A. MEMOIZED READING PANE — renderInto fires ONLY when the (openPlanPath, comments) key changes.
//   B. EMPTY-BEFORE-OPEN — a backward scrub before the first open_plan ⇒ the pane is rendered EMPTY.
//   C. COMMENT REVERSION — 3-comments → 0 (a from-scratch rebuild) ⇒ applyComments receives [].
//   D. GATE REVERT — gate on → off ⇒ clearGate fires (the un-invertible gate's backward re-drive).
//   E. SIDEBAR FULL-SET REVERT — a full-set plan_changed reverts on rewind (setPlans gets the seed).
//   F. SLICE-01 SEAM REGRESSION — after open_plan + a tab switch, #conversation-stream still carries
//      `mockanim-hidden-stream` + is empty (the reconciler never writes the production stream).
//   G. EPOCH GUARD — two back-to-back open_plans with the FIRST settle delayed end on the SECOND plan.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createReconciler,
  type ReconcilerSeams,
  QUESTION_OTHER_TEXT_SELECTOR,
} from "./reconcile";
import type { StoryFrame } from "./storyboard";
import { clonePlans } from "../fixtures/plans";
import {
  TRAILHEAD_PLANS,
  TRAILHEAD_MASTER_PATH,
  TRAILHEAD_MASTER_DOC,
} from "../fixtures/trailhead-plan";
import { asAbsPath, asStem, type CommentRecord, type PlanRecord } from "../../types";

// A minimal CommentRecord factory (the reconciler only forwards them to applyComments).
function comment(id: number): CommentRecord {
  return {
    quote: `q${id}`,
    block_line: null,
    block_end_line: null,
    occurrence: 0,
    comment: `c${id}`,
    id,
  };
}

// Build a spy seam bundle + a jsdom reading-pane element. `readPlan` resolves immediately unless a
// per-test override delays it (the epoch-guard test does).
function makeSeams(over?: Partial<ReconcilerSeams>): {
  seams: ReconcilerSeams;
  spies: { [K in keyof ReconcilerSeams]: ReconcilerSeams[K] };
  pane: HTMLElement;
} {
  const pane = document.createElement("div");
  pane.id = "reading-pane";
  document.body.appendChild(pane);

  const seams: ReconcilerSeams = {
    renderConv: vi.fn(),
    readPlan: vi.fn(async (path: string) => `# md for ${path}`),
    renderInto: vi.fn((p: HTMLElement, md: string) => {
      // Mirror the real facade enough for assertions: wipe + set a marker of the rendered markdown.
      p.innerHTML = "";
      p.dataset.md = md;
    }),
    settle: vi.fn(async () => {}),
    applyComments: vi.fn((p: HTMLElement, records: CommentRecord[]) => {
      // Mirror the real add-only highlight: append one .cmt-hl span per record.
      for (const r of records) {
        const span = document.createElement("span");
        span.className = "cmt-hl";
        span.dataset.c = String(r.id);
        p.appendChild(span);
      }
    }),
    readingPane: pane,
    planDirOf: (path: string) => path.slice(0, path.lastIndexOf("/")),
    setPlans: vi.fn(),
    emitPlanChanged: vi.fn(),
    setPendingReviews: vi.fn(),
    emitReviewRequested: vi.fn(),
    emitReviewCancelled: vi.fn(),
    emitGate: vi.fn(),
    clearGate: vi.fn(),
    setActiveTab: vi.fn(),
    // ---- overlay seams (P1) ----
    setCursor: vi.fn(),
    setPulseTargets: vi.fn(),
    setFieldText: vi.fn(),
    setComposerOpen: vi.fn(),
    setSelPopover: vi.fn(),
    setProtoCard: vi.fn(),
    setQuestionAnswerUI: vi.fn(),
    ...over,
  };
  return { seams, spies: seams as never, pane };
}

const PLAN_A = "/Users/mock/.claude/plans/a.md";
const PLAN_B = "/Users/mock/.claude/plans/b.md";

beforeEach(() => {
  document.body.innerHTML = "";
});

// Flush the microtask queue enough times that the reconciler's async reading-pane read+render+settle
// chain (read → renderInto → applyComments → settle) has fully run.
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("reconcile — memoized reading pane (invariant A)", () => {
  it("renderInto fires ONLY on an (openPlanPath, comments) key change", async () => {
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "open_plan", path: PLAN_A } },
      { tMs: 100, frame: { t: "set_comments", path: PLAN_A, comments: [comment(1)] } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    // Tick at T=0 → open A (key1). Tick again at T=50 (same key) → NO new render.
    r.reconcile(0);
    r.reconcile(50);
    await flush();
    expect(seams.renderInto).toHaveBeenCalledTimes(1);

    // Tick at T=100 → comments changed (key2) → ONE more render.
    r.reconcile(100);
    await flush();
    expect(seams.renderInto).toHaveBeenCalledTimes(2);

    // Tick again at T=120 (same key) → no new render.
    r.reconcile(120);
    await flush();
    expect(seams.renderInto).toHaveBeenCalledTimes(2);
  });
});

describe("reconcile — empty before first open (invariant B)", () => {
  it("a backward scrub before the first open_plan renders the pane EMPTY", async () => {
    const story: StoryFrame[] = [
      { tMs: 1000, frame: { t: "open_plan", path: PLAN_A } },
    ];
    const { seams, pane } = makeSeams();
    const r = createReconciler(seams, story);

    // Forward to T=1000 (open A), then scrub BACK to T=0 (before the open).
    r.reconcile(1000);
    await Promise.resolve();
    await Promise.resolve();
    r.reconcile(0);

    // The LAST renderInto must be the empty render ("" markdown), and the pane has no content.
    const calls = (seams.renderInto as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1][1]).toBe("");
    expect(pane.innerHTML).toBe("");
  });
});

describe("reconcile — comment reversion 3→0 (invariant C)", () => {
  it("3 comments then 0 ⇒ the rebuilt pane has zero .cmt-hl spans", async () => {
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "open_plan", path: PLAN_A } },
      { tMs: 100, frame: { t: "set_comments", path: PLAN_A, comments: [comment(1), comment(2), comment(3)] } },
      { tMs: 200, frame: { t: "set_comments", path: PLAN_A, comments: [] } },
    ];
    const { seams, pane } = makeSeams();
    const r = createReconciler(seams, story);

    // At T=100 three comments are applied.
    r.reconcile(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(pane.querySelectorAll(".cmt-hl").length).toBe(3);

    // At T=200 the comments are gone → a from-scratch rebuild ⇒ zero spans.
    r.reconcile(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(pane.querySelectorAll(".cmt-hl").length).toBe(0);
    // applyComments was last called with [].
    const ac = (seams.applyComments as ReturnType<typeof vi.fn>).mock.calls;
    expect(ac[ac.length - 1][1]).toEqual([]);
  });
});

describe("reconcile — gate on→off (invariant D)", () => {
  it("gate on then off ⇒ clearGate fires", () => {
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "prototype_gate", on: true, round: 2 } },
      { tMs: 100, frame: { t: "prototype_gate", on: false } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(0);
    expect(seams.emitGate).toHaveBeenCalledWith("prototype", 2);
    expect(seams.clearGate).not.toHaveBeenCalled();

    r.reconcile(100);
    expect(seams.clearGate).toHaveBeenCalledTimes(1);
  });

  it("a backward scrub from gate-on to before-gate ⇒ clearGate fires (un-invertible revert)", () => {
    const story: StoryFrame[] = [
      { tMs: 1000, frame: { t: "prototype_gate", on: true, round: 1 } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(1000);
    expect(seams.emitGate).toHaveBeenCalledTimes(1);
    r.reconcile(0); // rewind before the gate frame → projected gate off → clearGate.
    expect(seams.clearGate).toHaveBeenCalledTimes(1);
  });
});

describe("reconcile — prototype-review bracket (gate + tab, invariant D2)", () => {
  // The TRAILHEAD prototype-review beat: a gate ON+open_plan bracket (Plan tab) for a window, then
  // gate OFF + open_plan{null} (flip back to Conversation). These mirror the real beat's surface
  // shape but use a SELF-CONTAINED story so the assertions don't depend on the full-beat tMs.
  const PROTO = "/Users/mock/.claude/plans/proto.md";
  function bracketStory(): StoryFrame[] {
    return [
      // Opening edge: gate ON + plan open (Plan tab).
      { tMs: 100, frame: { t: "open_plan", path: PROTO } },
      { tMs: 100, frame: { t: "prototype_gate", on: true, round: 1 } },
      // Closing edge: gate OFF + plan closed (flip back to Conversation).
      { tMs: 200, frame: { t: "prototype_gate", on: false } },
      { tMs: 200, frame: { t: "open_plan", path: null } },
    ];
  }

  it("gate on→off across the window ⇒ emitGate then clearGate", () => {
    const { seams } = makeSeams();
    const r = createReconciler(seams, bracketStory());

    r.reconcile(100); // inside the window: gate ON.
    expect(seams.emitGate).toHaveBeenCalledWith("prototype", 1);
    expect(seams.clearGate).not.toHaveBeenCalled();

    r.reconcile(200); // after the window: gate OFF.
    expect(seams.clearGate).toHaveBeenCalledTimes(1);
  });

  it("the open_plan bracket ⇒ setActiveTab('plan') then setActiveTab('conversation')", () => {
    const { seams } = makeSeams();
    const r = createReconciler(seams, bracketStory());

    r.reconcile(100); // plan open → Plan tab.
    expect(seams.setActiveTab).toHaveBeenCalledWith("plan");

    r.reconcile(200); // plan closed (open_plan{null}) → flip back to Conversation.
    expect(seams.setActiveTab).toHaveBeenCalledWith("conversation");
    // The flip-back is the LAST tab call. FALSIFIABILITY: remove the closing open_plan{path:null}
    // frame and the projection never re-derives activeTab="conversation" → this goes RED.
    const tabCalls = (seams.setActiveTab as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tabCalls[tabCalls.length - 1]).toBe("conversation");
  });

  it("backward scrub to mid-gate re-emits gate AND Plan tab; before the beat clears both", () => {
    const { seams } = makeSeams();
    const r = createReconciler(seams, bracketStory());

    // Play forward THROUGH the window first (so the gate genuinely turned on), then past it: gate ON
    // (emitGate) at mid-window, then gate OFF (clearGate) + Conversation tab after the window.
    r.reconcile(150); // inside the bracket: gate ON + Plan tab.
    expect(seams.emitGate).toHaveBeenCalledTimes(1);
    r.reconcile(300); // past the bracket: gate OFF + Conversation tab.
    expect(seams.clearGate).toHaveBeenCalledTimes(1);
    expect(seams.setActiveTab).toHaveBeenLastCalledWith("conversation");

    // Scrub BACK into the gate window → the un-invertible gate re-emits AND the Plan tab re-clicks.
    r.reconcile(150);
    expect(seams.emitGate).toHaveBeenLastCalledWith("prototype", 1);
    expect(seams.emitGate).toHaveBeenCalledTimes(2);
    expect(seams.setActiveTab).toHaveBeenLastCalledWith("plan");

    // Scrub BACK before the beat → gate cleared AND Conversation tab (no stuck Plan tab).
    r.reconcile(0);
    expect(seams.clearGate).toHaveBeenCalledTimes(2);
    expect(seams.setActiveTab).toHaveBeenLastCalledWith("conversation");
  });
});

describe("reconcile — sidebar full-set revert (invariant E)", () => {
  it("a full-set plan_changed reverts to the seed on rewind", () => {
    const customPlans: PlanRecord[] = [
      {
        absolute_path: asAbsPath(PLAN_B),
        filename_stem: asStem("b"),
        mtime_ms: 1,
        cwd: null,
        unread: false,
        flavor: "standalone",
        tree_id: null,
        nn: null,
        nn_path: null,
        child_count: null,
        collapsed: false,
        h1s: ["Custom"],
      },
    ];
    const story: StoryFrame[] = [
      { tMs: 1000, frame: { t: "plan_changed", plans: customPlans } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(1000);
    const firstArg = (seams.setPlans as ReturnType<typeof vi.fn>).mock.calls[0][0] as PlanRecord[];
    expect(firstArg.map((p) => p.absolute_path)).toEqual([PLAN_B]);

    // Rewind before the plan_changed → projection falls back to the fixture seed.
    r.reconcile(0);
    const calls = (seams.setPlans as ReturnType<typeof vi.fn>).mock.calls;
    const lastArg = calls[calls.length - 1][0] as PlanRecord[];
    expect(lastArg.map((p) => p.absolute_path)).toEqual(clonePlans().map((p) => p.absolute_path));
    // emitPlanChanged fires on each change.
    expect(seams.emitPlanChanged).toHaveBeenCalledTimes(2);
  });
});

describe("reconcile — Slice-01 seam regression (invariant F)", () => {
  it("after open_plan + tab switch, #conversation-stream keeps mockanim-hidden-stream + stays empty", async () => {
    // Build the conversation-stream chrome as the real app/player would: a hidden, empty stream.
    const wrap = document.createElement("div");
    wrap.className = "conv-stream-wrap";
    const stream = document.createElement("div");
    stream.id = "conversation-stream";
    stream.className = "conv-stream mockanim-hidden-stream";
    wrap.appendChild(stream);
    document.body.appendChild(wrap);

    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "open_plan", path: PLAN_A } },
    ];
    const { seams } = makeSeams();
    // setActiveTab spy: emulate the real tab-button click WITHOUT touching #conversation-stream.
    (seams.setActiveTab as ReturnType<typeof vi.fn>).mockImplementation((_tab: string) => {
      /* a real tab click toggles .tab-pane.active — it never writes #conversation-stream */
    });
    const r = createReconciler(seams, story);

    r.reconcile(0); // open A ⇒ activeTab "plan"
    await Promise.resolve();
    await Promise.resolve();

    expect(seams.setActiveTab).toHaveBeenCalledWith("plan");
    // The production stream is untouched: still hidden + empty.
    expect(stream.classList.contains("mockanim-hidden-stream")).toBe(true);
    expect(stream.innerHTML).toBe("");
  });
});

describe("reconcile — epoch guard (invariant G)", () => {
  it("two back-to-back open_plans (first settle delayed) end on the SECOND plan", async () => {
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "open_plan", path: PLAN_A } },
      { tMs: 100, frame: { t: "open_plan", path: PLAN_B } },
    ];

    // readPlan: A resolves on a DELAYED microtask; B resolves immediately. We want the LATE A read to
    // be aborted by the epoch guard so the pane ends on B.
    const release: { a: (() => void) | null } = { a: null };
    const readPlan = vi.fn((path: string) => {
      if (path === PLAN_A) {
        return new Promise<string>((resolve) => {
          release.a = () => resolve(`# md for ${PLAN_A}`);
        });
      }
      return Promise.resolve(`# md for ${path}`);
    });
    const { seams, pane } = makeSeams({ readPlan });
    const r = createReconciler(seams, story);

    // Open A (its read is pending), then immediately open B (resolves now).
    r.reconcile(0);
    r.reconcile(100);
    // Let B's read + render settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // NOW release A's stale read — its post-await mutations must be aborted by the epoch guard.
    release.a?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The pane must reflect B (the last open), never A.
    expect(pane.dataset.md).toBe(`# md for ${PLAN_B}`);
    // renderInto was called for B but NOT for A (A aborted before mutating).
    const rendered = (seams.renderInto as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);
    expect(rendered).toContain(`# md for ${PLAN_B}`);
    expect(rendered).not.toContain(`# md for ${PLAN_A}`);
  });
});

describe("reconcile — TRAILHEAD nested-plan reveal (invariant E, full-set)", () => {
  // The storyboard's closing beat: an EMPTY sidebar ([]) until plan_changed at 19800 reveals
  // TRAILHEAD_PLANS, plus an open_plan of the master at 20200 (left open). A self-contained story
  // mirrors that shape at simple tMs so the assertions don't depend on the full-beat timing. readPlan
  // serves the master's REAL markdown (mirroring read_plan_contents) so renderInto can be asserted on it.
  function revealStory(): StoryFrame[] {
    return [
      { tMs: 0, frame: { t: "plan_changed", plans: [] } },
      { tMs: 100, frame: { t: "plan_changed", plans: TRAILHEAD_PLANS } },
      { tMs: 200, frame: { t: "open_plan", path: TRAILHEAD_MASTER_PATH } },
    ];
  }

  it("plan_changed {TRAILHEAD_PLANS} ⇒ setPlans(TRAILHEAD_PLANS) + emitPlanChanged", () => {
    const { seams } = makeSeams();
    const r = createReconciler(seams, revealStory());

    r.reconcile(0); // empty set first.
    const firstArg = (seams.setPlans as ReturnType<typeof vi.fn>).mock.calls[0][0] as PlanRecord[];
    expect(firstArg).toEqual([]);

    r.reconcile(100); // the drafted tree is revealed.
    const calls = (seams.setPlans as ReturnType<typeof vi.fn>).mock.calls;
    const lastArg = calls[calls.length - 1][0] as PlanRecord[];
    expect(lastArg).toEqual(TRAILHEAD_PLANS);
    // emitPlanChanged fired on each distinct full-set change ([] then TRAILHEAD_PLANS).
    expect(seams.emitPlanChanged).toHaveBeenCalledTimes(2);
  });

  it("open_plan {master} ⇒ renderInto called with the master markdown", async () => {
    const readPlan = vi.fn(async (path: string) =>
      path === TRAILHEAD_MASTER_PATH ? TRAILHEAD_MASTER_DOC : `# md for ${path}`,
    );
    const { seams, pane } = makeSeams({ readPlan });
    const r = createReconciler(seams, revealStory());

    r.reconcile(200); // open the master.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // renderInto painted the master's real markdown into the pane.
    const rendered = (seams.renderInto as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);
    expect(rendered).toContain(TRAILHEAD_MASTER_DOC);
    expect(pane.dataset.md).toBe(TRAILHEAD_MASTER_DOC);
  });

  it("backward scrub to T in [0, 19800) ⇒ setPlans([]) (the empty reveal reverts cleanly)", () => {
    const { seams } = makeSeams();
    const r = createReconciler(seams, revealStory());

    r.reconcile(100); // forward: the tree is revealed.
    r.reconcile(50); // scrub BACK before the 100 plan_changed → the empty set is re-driven.
    const calls = (seams.setPlans as ReturnType<typeof vi.fn>).mock.calls;
    const lastArg = calls[calls.length - 1][0] as PlanRecord[];
    expect(lastArg).toEqual([]);
  });
});

// ====================================================================================================
// P1 OVERLAY PASSES — cursor lerp/hold, pulse-set diffing, field per-character dispatch, composer /
// popover / proto-card / question-UI on-change + backward-scrub revert. jsdom + spies. Every behavioral
// test below was FALSIFIED (the logic inverted to confirm RED) then restored — see the comment on each.
// ====================================================================================================

// jsdom's getBoundingClientRect returns an all-zeros rect; stub a fixed rect onto an element so the
// cursor pass can resolve a non-zero rect-center. Pass w=h=0 to simulate a display:none / zero-area node.
function stubRect(elem: HTMLElement, x: number, y: number, w: number, h: number): void {
  elem.getBoundingClientRect = () =>
    ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) }) as DOMRect;
}

function lastCall<K extends keyof ReconcilerSeams>(seams: ReconcilerSeams, key: K): unknown[] {
  const calls = (seams[key] as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1];
}

describe("reconcile — cursor lerp + hold (P1)", () => {
  it("lerps between two resolved rect-centers at a mid t01", () => {
    const a = document.createElement("div");
    a.id = "a";
    const b = document.createElement("div");
    b.id = "b";
    document.body.append(a, b);
    stubRect(a, 0, 0, 100, 100); // center (50,50)
    stubRect(b, 200, 200, 100, 100); // center (250,250)

    // Waypoint to #a at 0 (snaps), then to #b at 100 over 100ms → mid-move at T=150 is t01=0.5.
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "cursor_move", target: "#a", moveMs: 0 } },
      { tMs: 100, frame: { t: "cursor_move", target: "#b", moveMs: 100 } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(150); // travelling #a→#b, t01 = (150-100)/100 = 0.5 → center (150,150).
    const arg = lastCall(seams, "setCursor")[0] as { x: number; y: number; pressing: boolean };
    expect(arg.x).toBeCloseTo(150);
    expect(arg.y).toBeCloseTo(150);
    // FALSIFIABILITY: replacing the lerp with `fromPos` (t01 ignored) yields (50,50) here → RED. Confirmed.
  });

  it("HOLDS the last-good position when the destination target is absent (no jump to 0,0)", () => {
    const a = document.createElement("div");
    a.id = "a";
    document.body.append(a);
    stubRect(a, 0, 0, 100, 100); // center (50,50)
    // #b is NEVER added to the DOM (absent target).

    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "cursor_move", target: "#a", moveMs: 0 } },
      { tMs: 100, frame: { t: "cursor_move", target: "#missing", moveMs: 100 } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(0); // rest at #a → (50,50).
    expect((lastCall(seams, "setCursor")[0] as { x: number }).x).toBeCloseTo(50);
    r.reconcile(150); // travelling toward #missing (absent) → HOLD at the last-good (50,50), no (0,0).
    const held = lastCall(seams, "setCursor")[0] as { x: number; y: number };
    expect(held.x).toBeCloseTo(50);
    expect(held.y).toBeCloseTo(50);
    // FALSIFIABILITY: lerping toward an unresolved (0,0) dest would give roughly (25,25) here → RED.
    // (Verified by temporarily treating a null toPos as {x:0,y:0}.) Confirmed.
  });

  it("treats a ZERO-AREA rect (display:none) like an absent target → HOLD", () => {
    const a = document.createElement("div");
    a.id = "a";
    const b = document.createElement("div");
    b.id = "b";
    document.body.append(a, b);
    stubRect(a, 0, 0, 100, 100); // center (50,50)
    stubRect(b, 0, 0, 0, 0); // zero-area (display:none-like) → treated as absent.

    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "cursor_move", target: "#a", moveMs: 0 } },
      { tMs: 100, frame: { t: "cursor_move", target: "#b", moveMs: 100 } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(0);
    r.reconcile(150); // #b is zero-area → HOLD (50,50).
    const held = lastCall(seams, "setCursor")[0] as { x: number; y: number };
    expect(held.x).toBeCloseTo(50);
    expect(held.y).toBeCloseTo(50);
    // FALSIFIABILITY: dropping the (width===0 && height===0) guard makes #b resolve to its (0,0)-center
    // and the cursor lerps to ~(25,25) → RED. Confirmed.
  });

  it("setCursor(null) before the first cursor_move", () => {
    const story: StoryFrame[] = [{ tMs: 100, frame: { t: "cursor_move", target: "#a", moveMs: 0 } }];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);
    r.reconcile(0); // before the first move → no cursor.
    expect(lastCall(seams, "setCursor")[0]).toBeNull();
  });
});

describe("reconcile — pulse set diffing (P1)", () => {
  it("setPulseTargets fires on a CHANGED set, NOT on a stable tick", () => {
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "pulse", target: ".x", fromMs: 0, toMs: 100 } },
      { tMs: 0, frame: { t: "pulse", target: ".y", fromMs: 50, toMs: 100 } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(10); // {.x}
    expect(seams.setPulseTargets).toHaveBeenCalledTimes(1);
    expect([...(lastCall(seams, "setPulseTargets")[0] as Set<string>)].sort()).toEqual([".x"]);

    r.reconcile(20); // still {.x} → NO new call.
    expect(seams.setPulseTargets).toHaveBeenCalledTimes(1);

    r.reconcile(60); // {.x,.y} → changed → ONE more call.
    expect(seams.setPulseTargets).toHaveBeenCalledTimes(2);
    expect([...(lastCall(seams, "setPulseTargets")[0] as Set<string>)].sort()).toEqual([".x", ".y"]);

    r.reconcile(150); // both windows closed → {} → changed → ONE more.
    expect(seams.setPulseTargets).toHaveBeenCalledTimes(3);
    expect([...(lastCall(seams, "setPulseTargets")[0] as Set<string>)]).toEqual([]);
    // FALSIFIABILITY: removing the `if (key === lastPulseKey) return` memo makes the stable tick at T=20
    // fire a 2nd call → the `toHaveBeenCalledTimes(1)` assertion goes RED. Confirmed.
  });
});

describe("reconcile — field per-character dispatch (P1)", () => {
  it("setFieldText fires once per prefix change forward, and re-fires the SHORTER prefix on rewind", () => {
    // "abcd" typed into #f over [0,400) → one char per 100ms.
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "field_type", target: "#f", text: "abcd", fromMs: 0, toMs: 400 } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(0); // floor(0)→""
    r.reconcile(50); // still "" → no change (same prefix).
    r.reconcile(150); // "a"
    r.reconcile(250); // "ab"
    let calls = (seams.setFieldText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);
    // Distinct, monotonic prefixes only — NOT one per tick.
    expect(calls).toEqual(["", "a", "ab"]);

    r.reconcile(450); // T past toMs → full "abcd".
    calls = (seams.setFieldText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);
    expect(calls[calls.length - 1]).toBe("abcd");

    // BACKWARD scrub: T=150 → prefix shrinks back to "a", which differs from the last-applied "abcd",
    // so it RE-FIRES with the shorter prefix.
    r.reconcile(150);
    expect(lastCall(seams, "setFieldText")[1]).toBe("a");
    // FALSIFIABILITY: if setFieldText were called every tick regardless of change, calls after the first
    // four reconciles would be ["","","a","ab"] (the T=50 stable tick duplicating "") → the
    // `toEqual(["", "a", "ab"])` assertion goes RED. Confirmed by removing the prefix-changed guard.
  });
});

describe("reconcile — composer on/off + backward-scrub revert (P1)", () => {
  it("opens, then reverts to closed on an earlier scrub", () => {
    const story: StoryFrame[] = [
      { tMs: 100, frame: { t: "overlay_modal", kind: "composer", on: true } },
      { tMs: 300, frame: { t: "overlay_modal", kind: "composer", on: false } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(50); // before any frame → closed (first drive).
    expect(lastCall(seams, "setComposerOpen")[0]).toBe(false);
    r.reconcile(100); // open.
    expect(lastCall(seams, "setComposerOpen")[0]).toBe(true);
    r.reconcile(200); // still open → no new call.
    const callCountAtOpen = (seams.setComposerOpen as ReturnType<typeof vi.fn>).mock.calls.length;
    r.reconcile(250); // still open → no new call.
    expect((seams.setComposerOpen as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountAtOpen);
    // BACKWARD scrub to before the open frame → reverts to closed.
    r.reconcile(50);
    expect(lastCall(seams, "setComposerOpen")[0]).toBe(false);
    // FALSIFIABILITY: projectModalState is last-≤-T per kind; if it instead latched `true` forever, the
    // backward scrub would leave it `true` → the final `toBe(false)` goes RED. Confirmed.
  });
});

describe("reconcile — popover on/off + backward-scrub revert (P1)", () => {
  it("drives on+target, then reverts off on rewind", () => {
    const story: StoryFrame[] = [
      { tMs: 100, frame: { t: "overlay_modal", kind: "popover", on: true, target: "#blk" } },
      { tMs: 300, frame: { t: "overlay_modal", kind: "popover", on: false } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(150);
    expect(lastCall(seams, "setSelPopover")[0]).toEqual({ on: true, target: "#blk" });
    r.reconcile(350);
    expect(lastCall(seams, "setSelPopover")[0]).toEqual({ on: false, target: null });
    // BACKWARD scrub before the open → off.
    r.reconcile(0);
    expect(lastCall(seams, "setSelPopover")[0]).toEqual({ on: false, target: null });
    // FALSIFIABILITY: a stable-tick no-op would still keep the LAST call correct, so to make this
    // falsifiable we also assert the open call's target: dropping `target` from projectModalState's
    // popover branch would make the open call `{on:true,target:null}` → the first `toEqual` goes RED.
  });
});

describe("reconcile — proto-card on/off (derived from gate) + revert (P1)", () => {
  it("round mirrors the prototype gate; null when gate off; reverts on rewind", () => {
    const story: StoryFrame[] = [
      { tMs: 100, frame: { t: "prototype_gate", on: true, round: 1 } },
      { tMs: 200, frame: { t: "prototype_gate", on: true, round: 2 } },
      { tMs: 300, frame: { t: "prototype_gate", on: false } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(50); // before the gate → null.
    expect(lastCall(seams, "setProtoCard")[0]).toEqual({ round: null });
    r.reconcile(100); // gate on round 1.
    expect(lastCall(seams, "setProtoCard")[0]).toEqual({ round: 1 });
    r.reconcile(200); // gate on round 2.
    expect(lastCall(seams, "setProtoCard")[0]).toEqual({ round: 2 });
    r.reconcile(300); // gate off → hide.
    expect(lastCall(seams, "setProtoCard")[0]).toEqual({ round: null });
    // BACKWARD scrub into round 1 → card re-shows at round 1.
    r.reconcile(100);
    expect(lastCall(seams, "setProtoCard")[0]).toEqual({ round: 1 });
    // FALSIFIABILITY: deriving round from `surface.prototypeGate.round` unconditionally (ignoring `.on`)
    // would emit {round:2} at T=300 instead of {round:null} → the gate-off assertion goes RED. Confirmed.
  });
});

describe("reconcile — question Other-answer UI (derived from field text) + revert (P1)", () => {
  it("turns on with the typed text, then reverts to null before the field window", () => {
    const sel = QUESTION_OTHER_TEXT_SELECTOR;
    const story: StoryFrame[] = [
      { tMs: 100, frame: { t: "field_type", target: sel, text: "Android", fromMs: 100, toMs: 200 } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(50); // before the field window → null.
    expect(lastCall(seams, "setQuestionAnswerUI")[0]).toBeNull();
    r.reconcile(250); // past the window → full text, toggle checked.
    expect(lastCall(seams, "setQuestionAnswerUI")[0]).toEqual({ otherChecked: true, otherText: "Android" });
    // BACKWARD scrub before the window → reverts to null (the reconciler re-asserts off-state).
    r.reconcile(50);
    expect(lastCall(seams, "setQuestionAnswerUI")[0]).toBeNull();
    // FALSIFIABILITY: if the UI latched on after first turning on (never re-deriving null), the backward
    // scrub would leave the last call as the on-state → the final `toBeNull()` goes RED. Confirmed.
  });
});
