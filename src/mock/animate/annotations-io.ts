// Mock-ANIMATE annotation persistence CLIENT (Phase 2) — a tiny browser-side fetch wrapper over the
// dev-server middleware (`annotationsApiPlugin` in vite.mock.config.ts). The browser can't write
// files, so saving/loading an AnnotationDoc round-trips through the mock dev server.
//
// This is the one runtime `fetch` in the mock client (fixtures are static imports); that's expected —
// it talks to the dev-only /__mock_annotations endpoints that only exist while the mock server runs.

import type { AnnotationDoc } from "./annotations";

// Save `doc` under `name` (POST /__mock_annotations/save). Resolves to the absolute disk path the
// server wrote. Throws with the server's message on any non-200 response.
export async function saveDoc(name: string, doc: AnnotationDoc): Promise<string> {
  const res = await fetch("/__mock_annotations/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, doc }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`saveDoc failed (${res.status}): ${msg}`);
  }
  const body = (await res.json()) as { path: string };
  return body.path;
}

// Load the doc saved under `name` (GET /__mock_annotations/load?name=). Resolves to the parsed
// AnnotationDoc, or `null` when the file does not exist (404). Throws on any other non-OK status.
export async function loadDoc(name: string): Promise<AnnotationDoc | null> {
  const res = await fetch(`/__mock_annotations/load?name=${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`loadDoc failed (${res.status}): ${msg}`);
  }
  return (await res.json()) as AnnotationDoc;
}
