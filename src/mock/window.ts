// Mock shim for "@tauri-apps/api/window".
//
// titlebar.ts imports `getCurrentWindow` and calls `.startDragging()` / `.toggleMaximize()` on it
// (both async, gated behind capabilities in the real app). In the browser there is no native
// window chrome to drag, so these are inert no-ops — enough to satisfy the call sites without
// throwing.

interface MockAppWindow {
  startDragging(): Promise<void>;
  toggleMaximize(): Promise<void>;
}

const mockWindow: MockAppWindow = {
  startDragging: async () => {},
  toggleMaximize: async () => {},
};

export function getCurrentWindow(): MockAppWindow {
  return mockWindow;
}
