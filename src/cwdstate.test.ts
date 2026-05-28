import { describe, it, expect } from "vitest";

import { cwdState, setCwd, asStem, type Stem } from "./types";

describe("cwdState — three-state interpreter", () => {
  it("an ABSENT key is `unresolved`", () => {
    // Falsifiable: if absence were mapped to unknown/resolved, this exact-shape match fails.
    const map = new Map<Stem, string | null>();
    expect(cwdState(map, asStem("missing"))).toEqual({ state: "unresolved" });
  });

  it("a `null` value is `unknown`", () => {
    const map = new Map<Stem, string | null>([[asStem("u"), null]]);
    expect(cwdState(map, asStem("u"))).toEqual({ state: "unknown" });
  });

  it("a path value is `resolved` carrying that path", () => {
    const map = new Map<Stem, string | null>([[asStem("p"), "/some/cwd"]]);
    expect(cwdState(map, asStem("p"))).toEqual({ state: "resolved", path: "/some/cwd" });
  });

  it("setCwd writes the value cwdState reads back (round-trip)", () => {
    const map = new Map<Stem, string | null>();
    setCwd(map, asStem("p"), "/written/cwd");
    expect(cwdState(map, asStem("p"))).toEqual({ state: "resolved", path: "/written/cwd" });
    setCwd(map, asStem("p"), null);
    expect(cwdState(map, asStem("p"))).toEqual({ state: "unknown" });
  });
});
