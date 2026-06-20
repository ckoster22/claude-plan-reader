// Mock shim for "@tauri-apps/plugin-opener".
//
// render/links.ts imports `openUrl` to open external links in the OS default app. In the browser
// mock there is no OS app to hand off to, so this is a logging no-op (it does NOT navigate the
// page — matching the real contract that external links never navigate the WebView).

export async function openUrl(url: string): Promise<void> {
  console.log("[mock] openUrl (no-op):", url);
}
