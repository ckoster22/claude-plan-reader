// P4 integration smoke — drives the REAL reconciler (createReconciler) over TRAILHEAD_BEAT with real
// jsdom DOM nodes (#reading-pane, #sel-popover) and asserts the OUTPUT of the P4 surfaces:
//   (1) the prototype trail card renders INLINE in #reading-pane (the real app's inline-preview path —
//       there is NO floating overlay; review2 c3 deleted #demo-proto-card). The reconciler opens
//       PROTO_PREVIEW_PATH and renders its markdown (PROTO_PREVIEW_DOC, the ASCII trail card) into the
//       pane; round 2's gate frame is what main.ts's renderPrototypePreview would re-compose, but the
//       OPEN-PLAN backdrop alone already shows a coherent trail card — so the pane is never near-empty.
//   (2) the selection popover shows during the scripted commenting act (with quote text) and is hidden
//       before any popover frame.
import { describe, it, expect } from "vitest";
import { createReconciler, type ReconcilerSeams } from "./reconcile";
import { TRAILHEAD_BEAT, PROTO_CARD1_PULSE_FROM, PROTO_CLOSE_MS } from "./storyboard";
import { MOCK_MARKDOWN, fallbackMarkdown } from "../fixtures/markdown";

describe("P4 smoke — inline proto card + popover via the REAL reconciler", () => {
  function setup() {
    document.body.innerHTML = "";
    const pane = document.createElement("div"); pane.id = "reading-pane"; document.body.appendChild(pane);
    const pop = document.createElement("div"); pop.id = "sel-popover"; pop.className = "hidden"; document.body.appendChild(pop);
    const quote = document.createElement("div"); quote.id = "sp-quote"; pop.appendChild(quote);
    const block = document.createElement("p"); block.setAttribute("data-source-line", "4"); block.textContent = "block four"; pane.appendChild(block);
    const block53 = document.createElement("p"); block53.setAttribute("data-source-line", "53"); block53.textContent = "block 53"; pane.appendChild(block53);
    const seams: ReconcilerSeams = {
      renderConv: () => {}, applyComments: () => {}, settle: async () => {},
      // Serve the real fixture markdown so the reconciler's reading-pane pass opens the actual
      // PROTO_PREVIEW_DOC, and project it into the pane as text (a stand-in for the real markdown render).
      readPlan: async (path: string) => MOCK_MARKDOWN[path] ?? fallbackMarkdown(path),
      renderInto: (el: HTMLElement, md: string) => { el.textContent = md; },
      readingPane: pane, planDirOf: () => "/d",
      setPlans: () => {}, emitPlanChanged: () => {}, setPendingReviews: () => {}, emitReviewRequested: () => {},
      emitReviewCancelled: () => {}, emitGate: () => {}, clearGate: () => {}, setActiveTab: () => {},
      setSelPopover: (s: { on: boolean; target: string | null }) => {
        if (!s.on || s.target === null) { pop.classList.add("hidden"); return; }
        const b = document.querySelector(s.target);
        if (!b) { pop.classList.add("hidden"); return; }
        quote.textContent = (b.textContent ?? "").trim();
        pop.classList.remove("hidden");
      },
    };
    return { pane, pop, quote, reconciler: createReconciler(seams, TRAILHEAD_BEAT) };
  }

  it("the prototype is rendered INLINE in #reading-pane (the ASCII trail card), with NO floating overlay", async () => {
    const { pane, reconciler } = setup();
    reconciler.reconcile(PROTO_CARD1_PULSE_FROM);
    // The reconciler's reading-pane pass is async (awaits readPlan); drain it.
    await reconciler.settleBarrier();
    // The inline pane shows a COHERENT trail card — the trail name + stats, not a near-empty title.
    expect(pane.textContent).toContain("Eagle Peak Loop");
    expect(pane.textContent).toContain("6.2 mi");
    expect(pane.textContent).toContain("+1,400 ft");
    // Mermaid-free (review item #6): the inline preview is a plain ASCII fence, never a mermaid diagram.
    expect(pane.textContent).not.toContain("```mermaid");
    // REGRESSION GUARD (review2 c3): the deleted floating overlay element must NOT exist anywhere.
    expect(document.getElementById("demo-proto-card")).toBeNull();

    // After the gate closes + the pane closes (open_plan{null}), the inline card clears.
    reconciler.reconcile(PROTO_CLOSE_MS);
    await reconciler.settleBarrier();
    expect(pane.textContent).not.toContain("Eagle Peak Loop");
  });

  it("the selection popover SHOWS during the commenting act and hides after", () => {
    const { pop, quote, reconciler } = setup();
    // The first popover-on lands during comment 1's act. Find a T where popover is on.
    const popOn = TRAILHEAD_BEAT.find((sf) => sf.frame.t === "overlay_modal" && (sf.frame as any).kind === "popover" && (sf.frame as any).on === true)!;
    reconciler.reconcile(popOn.tMs + 50);
    expect(pop.classList.contains("hidden")).toBe(false);
    expect((quote.textContent ?? "").length).toBeGreaterThan(0);
    // Before any popover frame (T=0) it stays hidden.
    reconciler.reconcile(0);
    expect(pop.classList.contains("hidden")).toBe(true);
  });
});
