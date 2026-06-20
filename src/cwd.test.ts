import { describe, it, expect } from "vitest";

import { collapseHome, expandHome } from "./cwd";

describe("collapseHome — pure home-collapse helper", () => {
  it("replaces a leading home with ~", () => {
    expect(collapseHome("/Users/bob/repos/x", "/Users/bob")).toBe("~/repos/x");
  });

  it("collapses an exact-home path to bare ~", () => {
    expect(collapseHome("/Users/bob", "/Users/bob")).toBe("~");
  });

  it("leaves paths not under home unchanged", () => {
    expect(collapseHome("/var/log", "/Users/bob")).toBe("/var/log");
  });

  it("does NOT collapse a prefix that is not at a path boundary", () => {
    // /Users/bobby must not be treated as under home /Users/bob.
    expect(collapseHome("/Users/bobby/x", "/Users/bob")).toBe("/Users/bobby/x");
  });

  it("normalizes a trailing slash on home", () => {
    expect(collapseHome("/Users/bob/repos/x", "/Users/bob/")).toBe("~/repos/x");
  });

  it("returns the path unchanged when home is empty", () => {
    expect(collapseHome("/Users/bob/x", "")).toBe("/Users/bob/x");
  });
});

describe("expandHome — the inverse of collapseHome (resume read path)", () => {
  it("replaces a leading ~ with the absolute home", () => {
    expect(expandHome("~/repos/x", "/Users/bob")).toBe("/Users/bob/repos/x");
  });

  it("expands a bare ~ to the home dir", () => {
    expect(expandHome("~", "/Users/bob")).toBe("/Users/bob");
  });

  it("round-trips with collapseHome", () => {
    const abs = "/Users/bob/repos/acme/widgets";
    expect(expandHome(collapseHome(abs, "/Users/bob"), "/Users/bob")).toBe(abs);
  });

  it("is a NO-OP on an already-absolute path (so resolved-from-cache cwds are untouched)", () => {
    // FALSIFIABILITY: an absolute path must pass through unchanged — expanding it would corrupt it.
    expect(expandHome("/work/project", "/Users/bob")).toBe("/work/project");
  });

  it("normalizes a trailing slash on home", () => {
    expect(expandHome("~/repos/x", "/Users/bob/")).toBe("/Users/bob/repos/x");
  });

  it("does NOT expand a ~user-style prefix we never emit", () => {
    expect(expandHome("~bobby/x", "/Users/bob")).toBe("~bobby/x");
  });

  it("returns the path unchanged when home is empty", () => {
    expect(expandHome("~/x", "")).toBe("~/x");
  });
});
