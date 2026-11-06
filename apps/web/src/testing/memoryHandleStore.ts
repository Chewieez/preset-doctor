import type { HandleStore } from '../handleStore';

/** Test-only: a HandleStore that keeps the folder in memory, as IndexedDB would between visits. */
export function memoryHandleStore(initial: FileSystemDirectoryHandle | null = null): HandleStore {
  let stored = initial;
  return {
    load: () => Promise.resolve(stored),
    save: (h) => {
      stored = h;
      return Promise.resolve();
    },
  };
}
