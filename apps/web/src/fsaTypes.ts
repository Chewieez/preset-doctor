/**
 * The parts of the File System Access API that TypeScript's DOM types leave out, because only
 * Chromium browsers have them.
 */
export type PermissionMode = 'read' | 'readwrite';

export interface PermissionDescriptor {
  mode: PermissionMode;
}

/** Permission calls on a handle (Chromium). Optional, so a missing one is handled. */
export interface WithPermissions {
  queryPermission?(descriptor: PermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor: PermissionDescriptor): Promise<PermissionState>;
}

export interface DirectoryPickerOptions {
  id?: string;
  mode?: PermissionMode;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads';
}

export type ShowDirectoryPicker = (
  options?: DirectoryPickerOptions,
) => Promise<FileSystemDirectoryHandle>;

/** `window.showDirectoryPicker`, or undefined in browsers without folder access. */
export function directoryPicker(): ShowDirectoryPicker | undefined {
  const fn = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  return typeof fn === 'function' && window.isSecureContext
    ? (fn.bind(window) as ShowDirectoryPicker)
    : undefined;
}

/** Asks for read-write access if needed. Needs a recent click when the browser must prompt. */
export async function ensureWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as FileSystemDirectoryHandle & WithPermissions;
  const descriptor: PermissionDescriptor = { mode: 'readwrite' };
  if (!h.queryPermission && !h.requestPermission) return true;
  try {
    if ((await h.queryPermission?.(descriptor)) === 'granted') return true;
  } catch {
    // Fall through to asking.
  }
  try {
    return (await h.requestPermission?.(descriptor)) === 'granted';
  } catch {
    return false;
  }
}
