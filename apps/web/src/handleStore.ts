/**
 * Remembers the picked folder between visits. Browsers can store a folder handle in IndexedDB
 * (never the files, only the permission to ask for them again).
 */
export interface HandleStore {
  load(): Promise<FileSystemDirectoryHandle | null>;
  save(handle: FileSystemDirectoryHandle): Promise<void>;
}

const DB_NAME = 'preset-doctor';
const STORE = 'handles';
const KEY = 'studio-folder';

/** Every call swallows errors (private windows, blocked storage): remembering is a convenience. */
export function indexedDbHandleStore(): HandleStore {
  return {
    async load() {
      try {
        const db = await open();
        try {
          const value = await request(db.transaction(STORE).objectStore(STORE).get(KEY));
          return isDirectoryHandle(value) ? value : null;
        } finally {
          db.close();
        }
      } catch {
        return null;
      }
    },
    async save(handle) {
      try {
        const db = await open();
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(handle, KEY);
          await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
          });
        } finally {
          db.close();
        }
      } catch {
        // Not remembered; the user picks the folder again next time.
      }
    },
  };
}

function open(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  return request(req);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'directory'
  );
}
