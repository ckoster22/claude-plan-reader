// Mock shim for "@tauri-apps/plugin-dialog".
//
// conversation/wd-picker.ts imports `open` to show the native folder picker and returns the chosen
// directory. In the mock there is no native picker, so we return a CANNED directory path (never
// null) — so the composer's new-plan flow shows a real selection instead of a cancelled dialog.
//
// The real `open` is overloaded (file vs directory, single vs multiple) returning
// `string | string[] | null`. The app only ever calls it with `{ directory: true, multiple: false }`
// and treats the result as a single string. We keep a permissive signature that satisfies that
// call site and the type the caller awaits.

// A loose mirror of the dialog open-options the app passes (directory:true, multiple:false, title,
// defaultPath). Kept minimal — only what wd-picker.ts uses.
interface MockOpenOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
}

// The canned directory the picker "selects".
const CANNED_DIR = "/Users/mock/work/harness";

export async function open(_options?: MockOpenOptions): Promise<string | string[] | null> {
  return CANNED_DIR;
}
