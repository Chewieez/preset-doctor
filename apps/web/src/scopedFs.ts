import { joinPath, normalizePath, type PresetFs } from '@preset-doctor/core';

/** A view of one subfolder of another PresetFs, so core can treat it as its own root. */
export function scopedFs(base: PresetFs, prefix: string): PresetFs {
  // Normalized before joining, so '..' is refused instead of climbing out of the prefix.
  const at = (path: string): string => joinPath(prefix, normalizePath(path));
  const fs: PresetFs = {
    readText: async (p) => base.readText(at(p)),
    readBytes: async (p) => base.readBytes(at(p)),
    writeText: async (p, d) => base.writeText(at(p), d),
    writeBytes: async (p, d) => base.writeBytes(at(p), d),
    list: async (p) => base.list(at(p)),
    exists: async (p) => base.exists(at(p)),
    mkdir: async (p) => base.mkdir(at(p)),
  };
  const remove = base.remove?.bind(base);
  if (remove) {
    fs.remove = async (p) => {
      if (normalizePath(p) === '') throw new Error('Refusing to remove the root');
      return remove(at(p));
    };
  }
  return fs;
}
