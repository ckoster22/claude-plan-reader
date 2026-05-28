import { describe, it, expect } from "vitest";

import { collapseHome } from "./cwd";

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
