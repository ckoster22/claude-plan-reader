// Mock-ANIMATE annotation IO client tests — the browser-side fetch wrapper (saveDoc/loadDoc) against a
// MOCKED global `fetch`. The dev-server middleware name-guard is NOT covered here (it runs inside the
// Vite server, not in jsdom — it is verified by curl); these tests pin the CLIENT contract: the right
// URL/method/body on save, and 200/404/error handling on load.
//
// Falsifiable: each assertion goes RED if the impl posts to the wrong URL, returns the wrong field,
// swallows a 404 into a doc, or fails to throw on a 500 (each confirmed RED by a temporary break, then
// restored — see the task report).

import { afterEach, describe, it, expect, vi } from "vitest";

import { saveDoc, loadDoc } from "./annotations-io";
import type { AnnotationDoc } from "./annotations";

const sampleDoc: AnnotationDoc = {
  version: 1,
  durationMs: 1000,
  viewport: { w: 1280, h: 860 },
  comments: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not json");
    },
    text: async () => text,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saveDoc", () => {
  it("POSTs to /__mock_annotations/save with {name, doc} and returns the server path", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => jsonResponse(200, { path: "/abs/.mock-annotations/foo.json" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const path = await saveDoc("foo", sampleDoc);

    expect(path).toBe("/abs/.mock-annotations/foo.json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/__mock_annotations/save");
    expect(init).toBeDefined();
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "foo", doc: sampleDoc });
  });

  it("throws with the server status on a non-200 save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(400, "invalid name")));
    await expect(saveDoc("../evil", sampleDoc)).rejects.toThrow(/400/);
  });
});

describe("loadDoc", () => {
  it("returns the parsed doc on 200", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(200, sampleDoc));
    vi.stubGlobal("fetch", fetchMock);

    const doc = await loadDoc("foo");

    expect(doc).toEqual(sampleDoc);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/__mock_annotations/load?name=foo");
  });

  it("returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(404, "not found")));
    await expect(loadDoc("missing")).resolves.toBeNull();
  });

  it("throws on a 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(500, "boom")));
    await expect(loadDoc("foo")).rejects.toThrow(/500/);
  });
});
