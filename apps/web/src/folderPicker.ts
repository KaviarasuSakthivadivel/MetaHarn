/** Native folder picker — only available when this UI is running inside the Tauri shell
 * (apps/web/src-tauri). A plain browser cannot expose real filesystem paths for security
 * reasons (`<input type=webkitdirectory>` gives relative paths, never an absolute one), so in
 * that context callers fall back to the manual path text field instead of calling this. */

let dialogModule: typeof import("@tauri-apps/plugin-dialog") | null | undefined;

async function loadDialog() {
  if (dialogModule !== undefined) return dialogModule;
  if (!("__TAURI_INTERNALS__" in window)) {
    dialogModule = null;
    return dialogModule;
  }
  try {
    dialogModule = await import("@tauri-apps/plugin-dialog");
  } catch {
    dialogModule = null;
  }
  return dialogModule;
}

export async function isNativePickerAvailable(): Promise<boolean> {
  return (await loadDialog()) !== null;
}

/** Opens the OS folder picker. Returns the chosen absolute path, or null if the user cancelled
 * or the native picker isn't available in this context. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const dialog = await loadDialog();
  if (!dialog) return null;
  const selected = await dialog.open({ directory: true, multiple: false, defaultPath: defaultPath || undefined });
  if (!selected || Array.isArray(selected)) return null;
  return selected;
}
