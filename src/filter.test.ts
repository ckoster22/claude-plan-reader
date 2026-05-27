import { describe, it, expect } from "vitest";
import { matchesQuery, filterRecords, highlightInto, planCountText } from "./filter";
import { asAbsPath, asStem, type PlanRecord } from "./types";

// Build a PlanRecord with terse overrides (brands the two string fields). Defaults make a
// standalone with no headings; tests override flavor/tree_id/nn/child_count/cwd/h1s as needed.
function rec(
  over: Partial<Omit<PlanRecord, "absolute_path" | "filename_stem">> & {
    absolute_path: string;
    filename_stem: string;
    flavor: PlanRecord["flavor"];
  },
): PlanRecord {
  const { absolute_path, filename_stem, ...rest } = over;
  return {
    mtime_ms: 1_700_000_000_000,
    cwd: null,
    unread: false,
    tree_id: null,
    nn: null,
    child_count: null,
    collapsed: false,
    h1s: [],
    ...rest,
    absolute_path: asAbsPath(absolute_path),
    filename_stem: asStem(filename_stem),
  };
}

describe("matchesQuery — OR over title / cwd / h1s", () => {
  it("matches on the TITLE (filename_stem), case-insensitively", () => {
    const r = rec({ absolute_path: "/p/floor-plan.md", filename_stem: "floor-plan", flavor: "standalone" });
    expect(matchesQuery(r, "FLOOR")).toBe(true);
    // Falsifiability: a token absent from title/cwd/h1s must NOT match.
    expect(matchesQuery(r, "mermaid")).toBe(false);
  });

  it("matches on the CWD", () => {
    const r = rec({
      absolute_path: "/p/x.md",
      filename_stem: "x",
      flavor: "standalone",
      cwd: "~/repos/docusketch/imaging",
    });
    expect(matchesQuery(r, "imaging")).toBe(true);
    expect(matchesQuery(r, "estimating")).toBe(false);
  });

  it("matches on an H1 HEADING (heading-only haystack)", () => {
    const r = rec({
      absolute_path: "/p/x.md",
      filename_stem: "x",
      flavor: "standalone",
      cwd: "~/repos/a",
      h1s: ["Corner snapping algorithm", "Edge cases"],
    });
    // Neither title nor cwd contains "snapping" — only an H1 does.
    expect(matchesQuery(r, "snapping")).toBe(true);
    // Falsifiability: drop the h1s and the SAME query no longer matches.
    const noH1 = { ...r, h1s: [] as string[] };
    expect(matchesQuery(noH1, "snapping")).toBe(false);
  });

  it("empty / whitespace query matches EVERYTHING", () => {
    const r = rec({ absolute_path: "/p/x.md", filename_stem: "x", flavor: "standalone" });
    expect(matchesQuery(r, "")).toBe(true);
    expect(matchesQuery(r, "   ")).toBe(true);
  });

  it("a null cwd is not a crash and simply doesn't contribute a match", () => {
    const r = rec({ absolute_path: "/p/x.md", filename_stem: "abc", flavor: "standalone", cwd: null });
    expect(matchesQuery(r, "zzz")).toBe(false);
    expect(matchesQuery(r, "abc")).toBe(true);
  });
});

describe("filterRecords — basic filtering", () => {
  it("returns ALL records for an empty query", () => {
    const recs = [
      rec({ absolute_path: "/p/a.md", filename_stem: "a", flavor: "standalone" }),
      rec({ absolute_path: "/p/b.md", filename_stem: "b", flavor: "standalone" }),
    ];
    expect(filterRecords(recs, "")).toHaveLength(2);
  });

  it("keeps only matching standalones", () => {
    const recs = [
      rec({ absolute_path: "/p/floor.md", filename_stem: "floor-plan", flavor: "standalone" }),
      rec({ absolute_path: "/p/mermaid.md", filename_stem: "mermaid-fix", flavor: "standalone" }),
    ];
    const out = filterRecords(recs, "floor");
    expect(out.map((r) => String(r.filename_stem))).toEqual(["floor-plan"]);
  });

  it("a HEADING-ONLY match keeps the row (the haystack includes h1s)", () => {
    const recs = [
      rec({
        absolute_path: "/p/x.md",
        filename_stem: "opaque-stem",
        flavor: "standalone",
        cwd: "~/repos/a",
        h1s: ["Insurance estimate mapper"],
      }),
    ];
    const out = filterRecords(recs, "estimate");
    expect(out).toHaveLength(1);
    // Falsifiability: with the h1s dropped, the heading-only query filters the row OUT.
    const recsNoH1 = [{ ...recs[0], h1s: [] as string[] }];
    expect(filterRecords(recsNoH1, "estimate")).toHaveLength(0);
  });
});

describe("filterRecords — master→sub nesting is preserved (no orphans)", () => {
  // Pre-ordered display stream: master + 2 subs, then a standalone.
  function tree(): PlanRecord[] {
    return [
      rec({
        absolute_path: "/p/master.md",
        filename_stem: "master-a",
        flavor: "master",
        tree_id: "t",
        child_count: 2,
      }),
      rec({ absolute_path: "/p/s1.md", filename_stem: "alpha-sub01", flavor: "sub", tree_id: "t", nn: 1, h1s: ["Backend wiring"] }),
      rec({ absolute_path: "/p/s2.md", filename_stem: "alpha-sub02", flavor: "sub", tree_id: "t", nn: 2 }),
      rec({ absolute_path: "/p/solo.md", filename_stem: "solo", flavor: "standalone" }),
    ];
  }

  it("a matched SUB keeps its master in the result (master leads, then the sub) — never an orphan", () => {
    const out = filterRecords(tree(), "Backend wiring"); // matches only sub01's H1
    const stems = out.map((r) => String(r.filename_stem));
    // The master must precede the matched sub (a sub is never emitted without its master).
    expect(stems).toContain("master-a");
    expect(stems).toContain("alpha-sub01");
    expect(stems.indexOf("master-a")).toBeLessThan(stems.indexOf("alpha-sub01"));
    // The non-matching sub and the unrelated standalone are dropped.
    expect(stems).not.toContain("alpha-sub02");
    expect(stems).not.toContain("solo");
    // First emitted record is the master (so renderSidebar opens a .children container first).
    expect(out[0].flavor).toBe("master");
  });

  it("when the MASTER matches, the whole block (master + all subs) is kept intact", () => {
    const out = filterRecords(tree(), "master-a");
    const stems = out.map((r) => String(r.filename_stem));
    expect(stems).toEqual(["master-a", "alpha-sub01", "alpha-sub02"]);
  });

  it("an empty query keeps the full nested stream in order", () => {
    const out = filterRecords(tree(), "");
    expect(out.map((r) => String(r.filename_stem))).toEqual([
      "master-a",
      "alpha-sub01",
      "alpha-sub02",
      "solo",
    ]);
  });

  it("dropping a whole non-matching master group does not strand its subs", () => {
    const recs = tree();
    const out = filterRecords(recs, "solo");
    // Only the standalone survives; the master group (no match anywhere) is fully removed —
    // crucially no sub leaks through without its master.
    expect(out.map((r) => String(r.filename_stem))).toEqual(["solo"]);
    expect(out.some((r) => r.flavor === "sub")).toBe(false);
  });
});

describe("planCountText — count helper", () => {
  it("renders 'N of M' while filtering", () => {
    expect(planCountText(2, 8, "floor")).toBe("2 of 8");
  });
  it("renders the plain 'M file(s)' form for an empty query", () => {
    expect(planCountText(8, 8, "")).toBe("8 files");
    expect(planCountText(1, 1, "   ")).toBe("1 file");
  });
});

describe("highlightInto — safe DOM highlighting (jsdom)", () => {
  it("wraps exactly ONE <mark> around the matched (case-insensitive) slice, preserving surrounding text", () => {
    const el = document.createElement("span");
    highlightInto(el, "Floor plan corner snapping", "CORNER");
    const marks = el.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("corner"); // the ACTUAL slice from the source text
    // Full visible text is unchanged (mark is purely a wrapper).
    expect(el.textContent).toBe("Floor plan corner snapping");
  });

  it("renders NO <mark> for no match or an empty query (plain text)", () => {
    const el = document.createElement("span");
    highlightInto(el, "Floor plan", "mermaid");
    expect(el.querySelector("mark")).toBeNull();
    expect(el.textContent).toBe("Floor plan");

    const el2 = document.createElement("span");
    highlightInto(el2, "Floor plan", "");
    expect(el2.querySelector("mark")).toBeNull();
    expect(el2.textContent).toBe("Floor plan");
  });

  it("renders a `<` in the text as LITERAL text, never as markup (no innerHTML injection)", () => {
    const el = document.createElement("span");
    highlightInto(el, "a < b && c", "b");
    // The `<` must be a text node, not an element. No child elements except the single <mark>.
    expect(el.querySelectorAll("*").length).toBe(1); // only the <mark>
    expect(el.textContent).toBe("a < b && c");
    // Specifically: there is no spurious element parsed from the `<`.
    const marks = el.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("b");
  });
});
