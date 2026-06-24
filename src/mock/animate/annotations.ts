// Mock-ANIMATE annotation data model + PURE projections (NO DOM).
//
// A dev-only review-authoring layer over the scrubbable `mock-animate` demo: timestamp-pinned comments
// each carrying freehand/shape strokes, drawn over the screen at the comment's scrub-time `tMs`. This
// module is the storyboard-analogue for annotations — a SEPARATE, DOM-free module (mirroring the PURE
// style of storyboard.ts's projectSurfaceState / projectPulseSet) so it is unit-testable without a
// player. The player (index.ts) feeds an in-memory `AnnotationDoc` and projects the overlay as a pure
// function of (doc, T) each paint; persistence + author UI live in later phases.
//
// COORDINATES: stroke points are NORMALIZED to the viewport (0..1) plus the author's viewport size, so
// replay/capture at that same size reproduces the markup faithfully over the same app layout. `denorm`
// maps a normalized point back to pixels for a given viewport.

// One drawn mark. `pen` is a polyline through all `points`; `arrow`/`box` use [start, end] (points[0],
// points[1]). `color`/`width` are the stroke style.
export interface Stroke {
  tool: "pen" | "arrow" | "box";
  color: string;
  width: number;
  points: Array<[number, number]>; // normalized 0..1
}

// A timestamp-pinned comment: its scrub time `tMs`, free text, and the strokes drawn for it.
export interface AnnotationComment {
  id: string;
  tMs: number;
  text: string;
  strokes: Stroke[];
}

// The full saved artifact: the comments + the author's viewport size (for faithful replay) + duration.
export interface AnnotationDoc {
  version: 1;
  durationMs: number;
  viewport: { w: number; h: number };
  comments: AnnotationComment[];
}

// PURE: the comments ACTIVE at scrub time T — those within `windowMs` of T (boundary INCLUSIVE:
// |c.tMs - T| <= windowMs). Deterministic order: by tMs ascending, then id ascending.
//
// `onlyId` is an explicit ISOLATION for capture: when given, return JUST the comment with that id
// (regardless of the window), or empty if no comment has that id. This lets the capture script render
// one comment per frame even when several share a tMs.
export function projectActiveComments(
  doc: AnnotationDoc,
  T: number,
  windowMs = 180,
  onlyId?: string,
): AnnotationComment[] {
  if (onlyId !== undefined) {
    const one = doc.comments.find((c) => c.id === onlyId);
    return one ? [one] : [];
  }
  const out = doc.comments.filter((c) => Math.abs(c.tMs - T) <= windowMs);
  out.sort((a, b) => (a.tMs - b.tMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// PURE: distinct comment timestamps ascending, each with the COUNT of comments at exactly that tMs.
// Used to render scrubber tick marks (with a count badge when count > 1).
export function tickGroups(doc: AnnotationDoc): Array<{ tMs: number; count: number }> {
  const counts = new Map<number, number>();
  for (const c of doc.comments) {
    counts.set(c.tMs, (counts.get(c.tMs) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tMs, count]) => ({ tMs, count }));
}

// PURE: map a normalized (0..1) point to pixels for a viewport of width `vw` × height `vh`.
export function denorm(pt: [number, number], vw: number, vh: number): [number, number] {
  return [pt[0] * vw, pt[1] * vh];
}
