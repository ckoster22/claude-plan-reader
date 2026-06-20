// Mock shim for "@tauri-apps/api/event".
//
// Re-implements the slice of the event API the app uses: `listen`, `once`, `emit`, plus the
// `UnlistenFn` type. Maintains a per-event-name registry of handlers and a per-name BUFFER of
// emissions.
//
// REPLAY-ON-SUBSCRIBE (the key behavior): the control deck / scenes push frames via
// `emitMockEvent(name, payload)` which may run BEFORE the conversation domain registers its
// `listen("agent-stream", …)` handlers (initConversation is async). Without replay those early
// frames would be lost to the boot ordering race. So every emission is buffered per name and
// replayed to a listener the moment it subscribes — guaranteeing no frame is dropped regardless of
// subscribe/emit ordering.

// Matches @tauri-apps/api/event's UnlistenFn.
export type UnlistenFn = () => void;

// The event object shape the real API passes to handlers: { event, id, payload }.
export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;

// Per-name registry of live handlers (typed loosely — each name carries its own payload type at
// the call site; the registry is heterogeneous).
const handlers = new Map<string, Set<EventCallback<unknown>>>();
// Per-name buffer of every payload emitted so far (for replay-on-subscribe).
const buffers = new Map<string, unknown[]>();

// Per-name buffer cap: keep at most this many emissions per event name (drop the OLDEST when over).
// Bounds unbounded growth across a long session of repeated scene loads — a replayed buffer should
// never need more than the longest single scene's frame count, and old frames beyond the cap are
// stale anyway (a scene load clears the buffer first; this cap is the belt-and-suspenders guard
// against a caller that emits a huge stream without clearing).
const BUFFER_CAP = 500;

// Monotonic event id (mirrors the real API's per-emission id).
let nextId = 1;

function getHandlers(name: string): Set<EventCallback<unknown>> {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  return set;
}

function getBuffer(name: string): unknown[] {
  let buf = buffers.get(name);
  if (!buf) {
    buf = [];
    buffers.set(name, buf);
  }
  return buf;
}

// Deliver one payload to a single callback wrapped in the Event envelope.
function deliver<T>(name: string, cb: EventCallback<T>, payload: T): void {
  cb({ event: name, id: nextId++, payload });
}

// Subscribe to an event. Returns an unlisten fn. On subscribe, REPLAYS every buffered emission for
// this name to the new handler (in emission order) so frames emitted before this subscribe are not
// lost. Async to match the real API (callers `await listen(...)`).
export async function listen<T>(name: string, cb: EventCallback<T>): Promise<UnlistenFn> {
  const set = getHandlers(name);
  const typed = cb as EventCallback<unknown>;
  set.add(typed);

  // Replay-on-subscribe: flush the existing buffer to this brand-new handler.
  for (const payload of getBuffer(name)) {
    deliver(name, cb, payload as T);
  }

  return () => {
    set.delete(typed);
  };
}

// Subscribe for a SINGLE emission, then auto-unlisten. Matches the real `once`. Because of
// replay-on-subscribe, if anything was already buffered the first buffered item fires immediately.
export async function once<T>(name: string, cb: EventCallback<T>): Promise<UnlistenFn> {
  const un = await listen<T>(name, (e) => {
    un();
    cb(e);
  });
  return un;
}

// Emit an event from the app side (the real API's `emit`). Buffers + fans out. Kept for surface
// parity; the app does not call `emit` itself, but tests / future code might.
export async function emit<T>(name: string, payload?: T): Promise<void> {
  emitMockEvent(name, payload as T);
}

// Push a mock event into the bus (used by the deck / scenes). Buffers the payload (so a later
// subscriber replays it) AND fans it out to every current handler.
export function emitMockEvent<T>(name: string, payload: T): void {
  const buf = getBuffer(name);
  buf.push(payload);
  // Cap the buffer length (drop oldest) so a long session of emissions can't grow it unbounded.
  if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP);
  for (const cb of getHandlers(name)) {
    deliver(name, cb, payload);
  }
}

// Clear the buffer for a name (or all names) — e.g. when the deck switches scenes and does not want
// stale frames replayed to a future listener. Does not detach live handlers.
export function clearMockBuffer(name?: string): void {
  if (name === undefined) buffers.clear();
  else buffers.delete(name);
}
