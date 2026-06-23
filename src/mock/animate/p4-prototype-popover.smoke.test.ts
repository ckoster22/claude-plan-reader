// P4 integration smoke — drives the REAL reconciler (createReconciler) over TRAILHEAD_BEAT with real
// jsdom DOM nodes (#reading-pane, #demo-proto-card, #sel-popover) and asserts the OUTPUT of the P4
// surfaces: (1) the prototype trail card renders the real markdown.ts HTML exports — round 1 = the base
// card (no badge, --tc-scale 1), round 2 = the morphed card (Moderate badge, --tc-scale 1.3 > 1) — and
// hides after the gate closes; (2) the selection popover shows during the scripted commenting act (with
// quote text) and is hidden before any popover frame. The setProtoCard/setSelPopover seams mirror the
// player's (index.ts) wiring so this exercises the same round projection + popover drive the live app uses.
import { describe, it, expect } from "vitest";
import { createReconciler, type ReconcilerSeams } from "./reconcile";
import {
  TRAILHEAD_BEAT,
  PROTO_CARD1_PULSE_FROM,
  PROTO_CARD2_PULSE_FROM,
  PROTO_CLOSE_MS,
} from "./storyboard";
import {
  TRAILHEAD_PROTO_CARD_R1_HTML,
  TRAILHEAD_PROTO_CARD_R2_HTML,
} from "../fixtures/markdown";

// A faithful re-implementation of index.ts's setProtoCard (the same logic the player wires), so the
// smoke test exercises the REAL exports + scale through the REAL reconciler's round projection.
function makeProtoCardSeam(card: HTMLElement) {
  return (state: { round: number | null }) => {
    if (state.round === null) { card.style.display = "none"; return; }
    card.style.setProperty("--tc-scale", state.round >= 2 ? "1.3" : "1");
    card.innerHTML = state.round >= 2 ? TRAILHEAD_PROTO_CARD_R2_HTML : TRAILHEAD_PROTO_CARD_R1_HTML;
    card.style.display = "block";
  };
}

describe("P4 smoke — proto card + popover via the REAL reconciler", () => {
  function setup() {
    document.body.innerHTML = "";
    const pane = document.createElement("div"); pane.id = "reading-pane"; document.body.appendChild(pane);
    const card = document.createElement("div"); card.id = "demo-proto-card"; document.body.appendChild(card);
    const pop = document.createElement("div"); pop.id = "sel-popover"; pop.className = "hidden"; document.body.appendChild(pop);
    const quote = document.createElement("div"); quote.id = "sp-quote"; pop.appendChild(quote);
    const block = document.createElement("p"); block.setAttribute("data-source-line", "4"); block.textContent = "block four"; pane.appendChild(block);
    const block53 = document.createElement("p"); block53.setAttribute("data-source-line", "53"); block53.textContent = "block 53"; pane.appendChild(block53);
    const seams: ReconcilerSeams = {
      renderConv: () => {}, readPlan: async () => "", renderInto: () => {}, settle: async () => {},
      applyComments: () => {}, readingPane: pane, planDirOf: () => "/d",
      setPlans: () => {}, emitPlanChanged: () => {}, setPendingReviews: () => {}, emitReviewRequested: () => {},
      emitReviewCancelled: () => {}, emitGate: () => {}, clearGate: () => {}, setActiveTab: () => {},
      setProtoCard: makeProtoCardSeam(card),
      setSelPopover: (s: { on: boolean; target: string | null }) => {
        if (!s.on || s.target === null) { pop.classList.add("hidden"); return; }
        const b = document.querySelector(s.target);
        if (!b) { pop.classList.add("hidden"); return; }
        quote.textContent = (b.textContent ?? "").trim();
        pop.classList.remove("hidden");
      },
    };
    return { card, pop, quote, reconciler: createReconciler(seams, TRAILHEAD_BEAT) };
  }

  it("round 1 renders the base card (no badge); round 2 morphs LARGER with a Moderate badge", () => {
    const { card, reconciler } = setup();
    reconciler.reconcile(PROTO_CARD1_PULSE_FROM);
    expect(card.style.display).toBe("block");
    expect(card.querySelector(".tc-badge")).toBeNull();
    expect(card.querySelector(".tc-title")?.textContent).toBe("Eagle Peak Loop");
    expect(card.style.getPropertyValue("--tc-scale")).toBe("1");

    reconciler.reconcile(PROTO_CARD2_PULSE_FROM);
    expect(card.querySelector(".tc-badge")?.textContent).toBe("Moderate");
    expect(card.style.getPropertyValue("--tc-scale")).toBe("1.3");
    expect(Number(card.style.getPropertyValue("--tc-scale"))).toBeGreaterThan(1);

    // After the gate closes the card hides.
    reconciler.reconcile(PROTO_CLOSE_MS);
    expect(card.style.display).toBe("none");
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
