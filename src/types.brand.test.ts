import { describe, it, expect } from "vitest";
import { asAbsPath, asStem, type AbsPath, type Stem } from "./types";

// PERMANENT compile-time falsifiability fixture for the branded types. This file is under
// `src/`, which tsconfig.json type-checks (`"include": ["src"]`), so the `// @ts-expect-error`
// lines below are ENFORCED by `npx tsc --noEmit`: if a brand stopped rejecting the mistake it
// guards, tsc would flag the now-unused `@ts-expect-error` and fail. (Verified by deleting one
// of these lines and confirming tsc goes red, then restoring it.)

const p: AbsPath = asAbsPath("/x");
const s: Stem = asStem("y");

// @ts-expect-error AbsPath is not assignable to Stem (the two brands are distinct)
const s2: Stem = p;
// @ts-expect-error Stem is not assignable to AbsPath (the two brands are distinct)
const p2: AbsPath = s;
// @ts-expect-error a bare string cannot fill an AbsPath brand slot
const p3: AbsPath = "/raw";
// @ts-expect-error a bare string cannot fill a Stem brand slot
const s3: Stem = "raw";

describe("branded types", () => {
  it("brands are distinct from each other and from string (compile-time)", () => {
    // Runtime: brands are erased, so all of these are plain strings. The real assertions are
    // the four `@ts-expect-error` lines above, enforced by tsc.
    expect(typeof p).toBe("string");
    expect(typeof s).toBe("string");
    expect(typeof s2).toBe("string");
    expect(typeof p2).toBe("string");
    expect(typeof p3).toBe("string");
    expect(typeof s3).toBe("string");
  });
});
