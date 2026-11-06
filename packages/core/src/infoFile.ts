/**
 * The `.info` sidecar next to each user preset: `key = value` lines, e.g.
 *
 *   sync_info =
 *   user_id = 1000000001
 *   setting_id = PFUS...
 *   base_id = GFSG99_15
 *   updated_time = 1782278409
 *
 * Studio writes CRLF and leaves a trailing space after an empty value. Every byte is kept,
 * including unknown or malformed lines, so an untouched sidecar serializes back identically.
 */

export interface InfoLine {
  /** Text up to where the value starts, e.g. 'base_id = '. For non key/value lines, the whole line. */
  prefix: string;
  key?: string;
  value?: string;
  /** Trailing whitespace after the value. */
  suffix: string;
  /** Line ending that followed this line ('' for a final line without one). */
  eol: string;
}

export interface InfoFile {
  lines: InfoLine[];
}

export const INFO_KEYS = {
  syncInfo: 'sync_info',
  userId: 'user_id',
  settingId: 'setting_id',
  baseId: 'base_id',
  updatedTime: 'updated_time',
} as const;

export function parseInfoFile(text: string): InfoFile {
  const lines: InfoLine[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [, content = '', eol = ''] = m;
    if (content === '' && eol === '') break;
    lines.push(parseLine(content, eol));
  }
  return { lines };
}

function parseLine(content: string, eol: string): InfoLine {
  const kv = /^(\s*([^=]*?)\s*=[ \t]?)(.*?)(\s*)$/.exec(content);
  if (!kv || kv[2] === '') return { prefix: content, suffix: '', eol };
  const [, prefix = '', key = '', value = '', suffix = ''] = kv;
  // 'sync_info = ' matches as prefix 'sync_info = ' + empty value; keep that split stable.
  return { prefix, key, value, suffix, eol };
}

export function serializeInfoFile(info: InfoFile): string {
  return info.lines.map((l) => l.prefix + (l.value ?? '') + l.suffix + l.eol).join('');
}

export function getInfoValue(info: InfoFile, key: string): string | undefined {
  return info.lines.find((l) => l.key === key)?.value;
}

/** Returns a new InfoFile with `key` set; appends a `key = value` line if the key is absent. */
export function setInfoValue(info: InfoFile, key: string, value: string): InfoFile {
  const idx = info.lines.findIndex((l) => l.key === key);
  if (idx >= 0) {
    return { lines: info.lines.map((l, i) => (i === idx ? { ...l, value } : l)) };
  }
  const lines = info.lines.map((l) => ({ ...l }));
  const eol = lines.find((l) => l.eol !== '')?.eol ?? '\r\n';
  const last = lines[lines.length - 1];
  if (last && last.eol === '') last.eol = eol;
  lines.push({ prefix: `${key} = `, key, value, suffix: '', eol });
  return { lines };
}

/** All key/value pairs in file order (later duplicates win). */
export function infoEntries(info: InfoFile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of info.lines) if (l.key !== undefined) out[l.key] = l.value ?? '';
  return out;
}
