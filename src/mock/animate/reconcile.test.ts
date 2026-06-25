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
import {
  type StoryFrame,
  TRAILHEAD_BEAT,
  TERMINAL_MS,
  projectScroll,
  projectSidebarTab,
  C4_CONTENTS_TAB_SWITCH_MS,
  C4_PLANS_TAB_SWITCH_MS,
  C4_SCROLL_DOWN_TO,
  C4_SCROLL_UP_TO,
  PROTO_ACT_SHIFT,
  CLARIFIER_SHIFT,
  SIZER_SHIFT,
} from "./storyboard";
import { extractToc } from "../../render/toc";
import { buildToc } from "../../main";
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
    rebuildToc: vi.fn(),
    setPlans: vi.fn(),
    emitPlanChanged: vi.fn(),
    setPendingReviews: vi.fn(),
    emitReviewRequested: vi.fn(),
    emitReviewCancelled: vi.fn(),
    emitGate: vi.fn(),
    clearGate: vi.fn(),
    emitReviewGate: vi.fn(),
    clearReviewGate: vi.fn(),
    setActiveTab: vi.fn(),
    setSidebarTab: vi.fn(),
    // ---- overlay seams (P1) ----
    setCursor: vi.fn(),
    setPulseTargets: vi.fn(),
    setFieldText: vi.fn(),
    setComposerOpen: vi.fn(),
    setSelPopover: vi.fn(),
    setQuestionAnswerUI: vi.fn(),
    setScroll: vi.fn(),
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

describe("reconcile — (c5) in-process review_gate seam (Request changes bar)", () => {
  const MASTER = "/Users/mock/.claude/plans/master.md";

  it("review_gate on ⇒ emitReviewGate(planPath, commentCount); count re-fires as comments grow; off ⇒ clearReviewGate", () => {
    // The faithful c5 surface: the in-process gate turns ON for the OPEN plan (Submit disabled at 0
    // comments), then the comment set grows 1→2 and the seam RE-FIRES with the new count (Submit
    // enables), then the gate turns OFF.
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "open_plan", path: MASTER } },
      { tMs: 100, frame: { t: "review_gate", on: true, planPath: MASTER } },
      { tMs: 200, frame: { t: "set_comments", path: MASTER, comments: [comment(1)] } },
      { tMs: 300, frame: { t: "set_comments", path: MASTER, comments: [comment(1), comment(2)] } },
      { tMs: 400, frame: { t: "review_gate", on: false, planPath: null } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    // Gate ON with 0 comments → emitReviewGate(MASTER, 0) (Submit would be DISABLED).
    r.reconcile(100);
    expect(seams.emitReviewGate).toHaveBeenCalledWith(MASTER, 0);
    expect(seams.clearReviewGate).not.toHaveBeenCalled();

    // First comment lands → re-fires with count 1 (Submit would ENABLE). FALSIFIABILITY: if the seam
    // keyed only on (on, planPath) and ignored the count, this re-fire would NOT happen → RED.
    r.reconcile(200);
    expect(seams.emitReviewGate).toHaveBeenCalledWith(MASTER, 1);

    // Second comment → count 2.
    r.reconcile(300);
    expect(seams.emitReviewGate).toHaveBeenCalledWith(MASTER, 2);

    // Gate OFF → clearReviewGate.
    r.reconcile(400);
    expect(seams.clearReviewGate).toHaveBeenCalledTimes(1);
  });

  it("a backward scrub from gate-on to before-gate ⇒ clearReviewGate fires (un-invertible revert)", () => {
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "open_plan", path: MASTER } },
      { tMs: 1000, frame: { t: "review_gate", on: true, planPath: MASTER } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    r.reconcile(1000);
    expect(seams.emitReviewGate).toHaveBeenCalledTimes(1);
    r.reconcile(0); // rewind before the gate frame → projected gate off → clearReviewGate.
    expect(seams.clearReviewGate).toHaveBeenCalledTimes(1);
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

describe("reconcile — (P2) setScroll seam: lerped frac, #reader-scroll target, self-heals a rebuild", () => {
  it("drives setScroll with the lerped frac targeting #reader-scroll inside the window; null outside", () => {
    const story: StoryFrame[] = [
      { tMs: 100, frame: { t: "scroll", target: "#reader-scroll", fromFrac: 0, toFrac: 1, fromMs: 100, toMs: 300 } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    // Before the window → null (no scroll override).
    r.reconcile(50);
    expect(lastCall(seams, "setScroll")[0]).toBeNull();
    // Mid-window (T=200, halfway through [100,300)) → frac 0.5, target #reader-scroll.
    r.reconcile(200);
    expect(lastCall(seams, "setScroll")[0]).toEqual({ target: "#reader-scroll", frac: 0.5 });
    // After the window → null again (clean revert).
    r.reconcile(300);
    expect(lastCall(seams, "setScroll")[0]).toBeNull();
    // FALSIFIABILITY: if reconcileScroll memoized on a changed-value key (like the other passes) it would
    // still drive the right value here; the self-heal test below is what pins the every-tick discipline.
  });

  it("runs EVERY tick (no memo) so a set_comments reading-pane rebuild's scroll reset self-heals", async () => {
    // A scroll window that stays active ACROSS a set_comments frame (which triggers a reading-pane rebuild
    // — renderInto resets the container scrollTop to 0). setScroll must fire on EVERY tick (not memoized)
    // so the projected frac is re-asserted after the rebuild. With the determinism fix, a tick that runs a
    // render ALSO re-asserts the scroll in the ASYNC chain tail (after render+settle), so the LAST call
    // after each settled tick carries the projected frac.
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "open_plan", path: PLAN_A } },
      { tMs: 0, frame: { t: "scroll", target: "#reader-scroll", fromFrac: 0, toFrac: 1, fromMs: 0, toMs: 1000 } },
      // A set_comments AT T=500 mid-window → rebuilds the pane (resets scrollTop) → must self-heal.
      { tMs: 500, frame: { t: "set_comments", path: PLAN_A, comments: [comment(1)] } },
    ];
    const { seams } = makeSeams();
    const r = createReconciler(seams, story);

    const scrollFn = seams.setScroll as ReturnType<typeof vi.fn>;
    const last = (): unknown => scrollFn.mock.calls[scrollFn.mock.calls.length - 1]?.[0];

    r.reconcile(0); // open + scroll frac 0
    await flush();
    // After the settled open at T=0 the LAST setScroll re-asserts frac 0 (the async tail re-asserts).
    expect(last()).toEqual({ target: "#reader-scroll", frac: 0 });
    const afterOpen = scrollFn.mock.calls.length;

    r.reconcile(500); // the set_comments rebuild tick — scroll frac 0.5 re-asserted after the rebuild
    await flush();
    // The LAST call after the settled rebuild tick carries the projected frac 0.5 — the self-heal: the
    // render reset scrollTop, then the async tail re-asserted. FALSIFIABILITY: drop the async-tail
    // applyScroll re-assert and the rebuild leaves the LAST call as the PRE-render sync 0.5 only IF the
    // render didn't run — but the render DID run, so without the re-assert the deterministic landing is
    // lost (the live CDP gap). The sync-pass 0.5 still records, but the async self-heal is what the live
    // layer needs; here we pin that the LAST call is the projected frac.
    expect(last()).toEqual({ target: "#reader-scroll", frac: 0.5 });

    const beforeT600 = scrollFn.mock.calls.length;
    r.reconcile(600); // next tick — no render (unchanged key) → only the SYNC pass fires; frac 0.6.
    r.reconcile(600); //   re-tick at the SAME T still re-drives (no change-memo skip).
    await flush();
    // The duplicate T=600 ticks (no render) each fire the SYNC reconcileScroll → proves no memo (a memoized
    // pass would skip the second). Both land frac 0.6.
    expect(last()).toEqual({ target: "#reader-scroll", frac: 0.6 });
    // No-memo proof: the two no-render T=600 ticks added EXACTLY 2 sync setScroll calls (no async tail ran,
    // since the reading key was unchanged). A changed-value memo would add ≤1. FALSIFIABILITY: add a memo
    // to reconcileScroll and this delta drops to 1 → RED.
    expect(scrollFn.mock.calls.length - beforeT600).toBe(2);
    void afterOpen;
  });

  it("setScroll runs AFTER reconcileReadingPane in the pass order (synchronous empty-pane rebuild)", () => {
    // Source-order guarantee: in reconcile(), reconcileScroll is invoked AFTER reconcileReadingPane. The
    // open-PATH reading-pane render is async (a detached microtask chain), so to observe pass ORDER on a
    // single synchronous tick we use the EMPTY-pane branch (open_plan{null}), whose renderInto is
    // SYNCHRONOUS. setScroll must fire AFTER that renderInto. FALSIFIABILITY: move reconcileScroll above
    // reconcileReadingPane in reconcile() and the recorded order flips → RED.
    const order: string[] = [];
    const { seams } = makeSeams({
      renderInto: vi.fn(() => order.push("renderInto")),
      setScroll: vi.fn(() => order.push("setScroll")),
    });
    const story: StoryFrame[] = [
      // open_plan{null} → the synchronous empty render; a scroll window active at the same T.
      { tMs: 0, frame: { t: "open_plan", path: null } },
      { tMs: 0, frame: { t: "scroll", target: "#reader-scroll", fromFrac: 0, toFrac: 1, fromMs: 0, toMs: 1000 } },
    ];
    const r = createReconciler(seams, story);
    r.reconcile(0);
    const firstRender = order.indexOf("renderInto");
    const firstScroll = order.indexOf("setScroll");
    expect(firstRender).toBeGreaterThanOrEqual(0);
    expect(firstScroll).toBeGreaterThan(firstRender);
  });
});

// ====================================================================================================
// (P6) WHOLE-TIMELINE SCRUB-REVERT — the reconciler-level companion to the projection-purity property
// test in storyboard.test.ts. Sweeps a reconciler FORWARD across many T over the real TRAILHEAD_BEAT,
// then drives it BACK to an early T, and asserts the final OVERLAY seam-driven state (cursor, pulse set,
// composer, popover, question-UI) matches driving DIRECTLY to that early T from a FRESH
// reconciler. Because each overlay seam is a pure projection of T and the reconciler re-derives the full
// state every tick (un-invertible surfaces rebuilt from scratch), forward-then-back == direct.
//
// A fresh reconciler's FIRST reconcile(earlyT) always fires every seam (no prior memo), so its last-call
// per seam is the canonical state at earlyT. The swept reconciler, after its back-scrub to earlyT, must
// have re-driven each seam to that same last value (a changed value re-fires; an unchanged value was
// already correct). jsdom rects are all-zero, so cursor/popover positions are deterministic across both
// paths — we compare the two drive paths, not absolute pixels.
//
// FALSIFIABILITY (verified): temporarily make the popover pass LATCH (skip re-driving when the popover
// goes off after having been on — i.e. never emit {on:false} once shown) and the swept-back early-T last
// call for setSelPopover becomes {on:true,…} while the direct path is {on:false,…} → the deep-equal goes
// RED. Restoring the re-derive turns it green. Confirmed locally before commit.
describe("reconcile — (P6) whole-timeline forward-then-back == direct (overlay seams)", () => {
  // The overlay seams whose last call is a pure fn of T (their projected value carries no host-DOM
  // identity that would differ between two reconcilers over the same all-zero-rect jsdom).
  const OVERLAY_SEAMS = [
    "setCursor",
    "setPulseTargets",
    "setComposerOpen",
    "setSelPopover",
    "setQuestionAnswerUI",
  ] as const;

  // Normalize a last-call arg to a deep-comparable string (Set → sorted array).
  function ser(arg: unknown): string {
    if (arg instanceof Set) return JSON.stringify([...arg].sort());
    return JSON.stringify(arg ?? null);
  }

  it("sweeping forward across the whole beat then back to an early T equals driving directly there", () => {
    const end = TERMINAL_MS;
    // A grid of forward sweep stops across the whole timeline, then back DOWN to each early target.
    const forwardGrid = Array.from({ length: 41 }, (_, i) => Math.round((i / 40) * end));
    // The early targets to land on after the forward sweep (spread across the front + mid of the beat).
    const earlyTargets = [0, Math.round(end * 0.1), Math.round(end * 0.41), Math.round(end * 0.7)];

    for (const earlyT of earlyTargets) {
      // ---- DIRECT path: a FRESH reconciler driven straight to earlyT (first tick fires every seam). ----
      const direct = makeSeams();
      const dr = createReconciler(direct.seams, TRAILHEAD_BEAT);
      dr.reconcile(earlyT);

      // ---- SWEPT path: sweep all the way forward, then back to earlyT. ----
      const swept = makeSeams();
      const sr = createReconciler(swept.seams, TRAILHEAD_BEAT);
      for (const T of forwardGrid) sr.reconcile(T);
      sr.reconcile(earlyT); // back-scrub to the early target.

      for (const seam of OVERLAY_SEAMS) {
        const directLast = lastCall(direct.seams, seam);
        const sweptLast = lastCall(swept.seams, seam);
        // Both paths MUST have driven the seam at least once (the direct first-tick always does).
        expect(directLast, `direct ${seam} drove at earlyT=${earlyT}`).toBeDefined();
        expect(sweptLast, `swept ${seam} drove by earlyT=${earlyT}`).toBeDefined();
        expect(
          ser(sweptLast?.[0]),
          `${seam} forward-then-back == direct at earlyT=${earlyT}`,
        ).toBe(ser(directLast?.[0]));
      }
    }
  });
});

// ====================================================================================================
// (c4) Contents-tab ToC navigation — the rebuildToc + setSidebarTab seams + scroll direction.
//
// The reconciler must (1) rebuild the Contents ToC from the rendered master pane (the REAL extractToc→
// buildToc), so #toc-list is populated (with a "Context" entry) during the c4 window; (2) drive the
// sidebar tab to "contents" then back to "plans"; and (3) drive the pane scroll HIGH (~1) after the low
// ToC-entry beat and back to ~0 after the Context beat, with NO two scroll windows overlapping.
describe("reconcile — (c4) Contents-tab ToC navigation", () => {
  // The c4 sidebar_tab/scroll frames live in DOWNSTREAM_HEAD (shifted by the head shift only).
  const HEAD_SHIFT = PROTO_ACT_SHIFT + CLARIFIER_SHIFT + SIZER_SHIFT;
  const CONTENTS_SWITCH_LIVE = C4_CONTENTS_TAB_SWITCH_MS + HEAD_SHIFT;
  const PLANS_SWITCH_LIVE = C4_PLANS_TAB_SWITCH_MS + HEAD_SHIFT;
  const SCROLL_DOWN_TO_LIVE = C4_SCROLL_DOWN_TO + HEAD_SHIFT;
  const SCROLL_UP_TO_LIVE = C4_SCROLL_UP_TO + HEAD_SHIFT;

  it("rebuildToc fires AFTER the master render+settle and on the empty-pane close", async () => {
    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "open_plan", path: TRAILHEAD_MASTER_PATH } },
      { tMs: 100, frame: { t: "open_plan", path: null } },
    ];
    const { seams } = makeSeams({
      readPlan: vi.fn(async () => TRAILHEAD_MASTER_DOC),
    });
    const r = createReconciler(seams, story);
    r.reconcile(0);
    await flush();
    // After the master open + settle, rebuildToc fired with the pane.
    expect((seams.rebuildToc as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    const afterOpen = (seams.rebuildToc as ReturnType<typeof vi.fn>).mock.calls.length;
    // The empty-pane close also rebuilds (an empty ToC) — synchronous in reconcileReadingPane.
    r.reconcile(100);
    await flush();
    expect((seams.rebuildToc as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(afterOpen);
    // FALSIFIABILITY: remove the rebuildToc call from reconcileReadingPane and both counts stay 0 → RED.
  });

  it("the REAL extractToc→buildToc populates #toc-list with a 'Context' entry from the rendered master", async () => {
    // A faithful renderInto that produces the master's headings (h1 + h2 Context + h2 Decomposition) with
    // their data-source-line, then the REAL rebuildToc (extractToc→buildToc) over a real #toc-list. This
    // exercises the production data flow end-to-end (no spy ToC). FALSIFIABILITY: if rebuildToc never fires
    // (remove its reconciler call) #toc-list stays empty → the length + "Context" assertions go RED.
    const tocList = document.createElement("div");
    tocList.id = "toc-list";
    document.body.appendChild(tocList);

    const story: StoryFrame[] = [
      { tMs: 0, frame: { t: "open_plan", path: TRAILHEAD_MASTER_PATH } },
    ];
    const { seams, pane } = makeSeams({
      readPlan: vi.fn(async () => TRAILHEAD_MASTER_DOC),
      // Render the master's headings faithfully (the real markdown render stamps data-source-line).
      renderInto: vi.fn((p: HTMLElement) => {
        p.innerHTML =
          '<h1 data-source-line="0">Master Plan: Trailhead — trail-finder mobile app</h1>' +
          '<p data-source-line="4">Trailhead is an Android-first mobile app…</p>' +
          '<h2 data-source-line="2">Context</h2>' +
          '<h2 data-source-line="6">Decomposition</h2>';
      }),
      // The REAL production data flow.
      rebuildToc: (p: HTMLElement) => buildToc(tocList, extractToc(p)),
    });
    const r = createReconciler(seams, story);
    r.reconcile(0);
    await flush();

    const items = Array.from(tocList.querySelectorAll<HTMLElement>(".toc-item"));
    expect(items.length).toBeGreaterThanOrEqual(2);
    const texts = items.map((el) => el.textContent);
    expect(texts).toContain("Context");
    expect(texts).toContain("Decomposition");
    // The "Context" row carries the heading's source line (the scroll anchor key).
    const contextRow = items.find((el) => el.textContent === "Context");
    expect(contextRow?.dataset.line).toBe("2");
    void pane;
  });

  it("setSidebarTab drives 'contents' during the c4 navigation, then 'plans' before commenting", () => {
    const { seams } = makeSeams();
    const r = createReconciler(seams, TRAILHEAD_BEAT);
    // At the Contents switch → setSidebarTab last-called with "contents".
    r.reconcile(CONTENTS_SWITCH_LIVE);
    expect(lastCall(seams, "setSidebarTab")![0]).toBe("contents");
    // At the Plans restore → "plans".
    r.reconcile(PLANS_SWITCH_LIVE);
    expect(lastCall(seams, "setSidebarTab")![0]).toBe("plans");
    // FALSIFIABILITY: drop the "contents" sidebar_tab frame and the first assertion goes RED ("plans").
  });

  it("scroll is HIGH (~1) at the end of the low-entry beat and ~0 after the Context beat; windows don't overlap", () => {
    // projectScroll over the LIVE beat: just before the down window closes → frac near 1 (scrolled down);
    // just before the up window closes → frac near 0 (scrolled back to the top). FALSIFIABILITY: swap the
    // two scroll directions (down toFrac 0, up toFrac 1) and these go RED.
    const downEnd = projectScroll(TRAILHEAD_BEAT, SCROLL_DOWN_TO_LIVE - 1);
    expect(downEnd).not.toBeNull();
    expect(downEnd!.frac).toBeGreaterThan(0.95);
    const upEnd = projectScroll(TRAILHEAD_BEAT, SCROLL_UP_TO_LIVE - 1);
    expect(upEnd).not.toBeNull();
    expect(upEnd!.frac).toBeLessThan(0.05);
    // NO overlap: scan the union of the two windows; never are both active (projectScroll is last-wins, so
    // an overlap would be silently masked — assert directly on the frame windows that no T is in both).
    const scrolls = TRAILHEAD_BEAT.filter((sf) => sf.frame.t === "scroll");
    const down = scrolls.find((sf) => (sf.frame as { toFrac: number }).toFrac === 1)!.frame as { fromMs: number; toMs: number };
    const up = scrolls.find((sf) => (sf.frame as { toFrac: number }).toFrac === 0)!.frame as { fromMs: number; toMs: number };
    for (let T = down.fromMs; T < up.toMs; T += 50) {
      const inDown = down.fromMs <= T && T < down.toMs;
      const inUp = up.fromMs <= T && T < up.toMs;
      expect(inDown && inUp, `no scroll-window overlap at T=${T}`).toBe(false);
    }
  });

  it("setSidebarTab scrub-revert: forward-then-back to before the c4 nav restores 'plans'", () => {
    const { seams } = makeSeams();
    const r = createReconciler(seams, TRAILHEAD_BEAT);
    // Sweep forward through the c4 nav (contents) then back to T=0 (before any sidebar_tab frame).
    r.reconcile(CONTENTS_SWITCH_LIVE);
    r.reconcile(PLANS_SWITCH_LIVE);
    r.reconcile(0);
    // The default "plans" is re-asserted (projectSidebarTab is a pure last-≤-T re-derivation).
    expect(projectSidebarTab(TRAILHEAD_BEAT, 0)).toBe("plans");
    expect(lastCall(seams, "setSidebarTab")![0]).toBe("plans");
  });

  // ---- LIVE-PATH determinism: reconcileScroll applied to a REAL #reader-scroll after a settled render ----
  //
  // The unit tests above pin projectScroll in ISOLATION. The LIVE bug (found via CDP) was that on a FRESH
  // seekSettled(T), the reading-pane render (read→renderInto→applyComments→settle→rebuildToc) resets
  // scrollTop to 0 AFTER the synchronous reconcileScroll(T) ran — and with no subsequent tick to self-heal,
  // a scrolled beat landed at 0. This test exercises the FULL reconcile path with a REAL #reader-scroll +
  // the player's actual frac→pixels setScroll, asserting that AFTER a settled seek (await settleBarrier)
  // scrollTop > 0 at the down beat and ~0 at the Context beat.
  //
  // jsdom computes no layout, so we stub a scroll RANGE on #reader-scroll (scrollHeight/clientHeight) and a
  // real scrollTop accessor. The render seam resets scrollTop to 0 (mirroring the real renderInto wiping +
  // re-laying-out the pane). FALSIFIABILITY (verified): remove the async-tail applyScroll re-assert and the
  // down-beat assertion goes RED (scrollTop stays 0 — the render reset it after the sync setScroll ran).
  it("LIVE PATH: a fresh settled seek lands #reader-scroll.scrollTop > 0 at the down beat, ~0 at the Context beat", async () => {
    // The c4 scroll frames live in DOWNSTREAM_HEAD → shifted by the full head shift (incl. SIZER_SHIFT).
    const HEAD_SHIFT2 = PROTO_ACT_SHIFT + CLARIFIER_SHIFT + SIZER_SHIFT;
    const DOWN_BEAT_T = C4_SCROLL_DOWN_TO + HEAD_SHIFT2 - 1; // frac ~1 (scrolled all the way down)
    const CONTEXT_BEAT_T = C4_SCROLL_UP_TO + HEAD_SHIFT2 - 1; // frac ~0 (back at the top)
    const PRE_SCROLL_T = 0; // before any scroll window → scrollTop untouched (starts 0)

    // A real #reader-scroll with a stubbed 500px scroll range (scrollHeight 800, clientHeight 300).
    const reader = document.createElement("div");
    reader.id = "reader-scroll";
    document.body.appendChild(reader);
    let scrollTop = 0;
    Object.defineProperty(reader, "scrollHeight", { configurable: true, get: () => 800 });
    Object.defineProperty(reader, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(reader, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    // The player's ACTUAL setScroll logic (frac→pixels against the live range); null ⇒ untouched.
    const realSetScroll = (state: { target: string; frac: number } | null): void => {
      if (state === null) return;
      const container = document.querySelector(state.target) as HTMLElement | null;
      if (!container) return;
      const range = container.scrollHeight - container.clientHeight;
      if (range <= 0) return;
      const next = Math.round(state.frac * range);
      if (Math.abs(container.scrollTop - next) > 0.5) container.scrollTop = next;
    };

    const { seams } = makeSeams({
      readPlan: vi.fn(async () => TRAILHEAD_MASTER_DOC),
      // The render RESETS scrollTop to 0 (mirroring the real renderInto wiping + re-laying-out the pane).
      renderInto: vi.fn((p: HTMLElement) => {
        p.innerHTML = '<h1 data-source-line="0">Master</h1>';
        scrollTop = 0;
      }),
      // settle + rebuildToc also touch the pane; keep them resetting scrollTop to harden the test.
      settle: vi.fn(async () => {
        scrollTop = 0;
      }),
      rebuildToc: vi.fn(() => {
        scrollTop = 0;
      }),
      setScroll: realSetScroll,
    });
    const r = createReconciler(seams, TRAILHEAD_BEAT);

    // Fresh settled seek to the DOWN beat: scrollTop must end > 0 (scrolled down) AFTER the render+settle.
    r.reconcile(DOWN_BEAT_T);
    await r.settleBarrier();
    await flush();
    expect(scrollTop, "down beat scrollTop > 0 (scrolled down)").toBeGreaterThan(0);

    // Fresh settled seek to the CONTEXT beat: scrollTop must end ~0 (back at the top).
    r.reconcile(CONTEXT_BEAT_T);
    await r.settleBarrier();
    await flush();
    expect(scrollTop, "Context beat scrollTop ~0 (back at top)").toBeLessThanOrEqual(2);

    // Backward scrub to a pre-scroll T: no scroll window → scrollTop untouched (stays at the Context ~0).
    r.reconcile(PRE_SCROLL_T);
    await r.settleBarrier();
    await flush();
    expect(scrollTop, "pre-scroll T leaves scrollTop ~0").toBeLessThanOrEqual(2);

    // And a backward scrub from the Context beat back to the DOWN beat re-lands scrollTop > 0 (revert both ways).
    r.reconcile(DOWN_BEAT_T);
    await r.settleBarrier();
    await flush();
    expect(scrollTop, "backward scrub to the down beat re-scrolls down").toBeGreaterThan(0);
  });
});
