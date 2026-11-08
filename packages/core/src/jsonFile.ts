/**
 * Read and write preset JSON without disturbing its formatting.
 *
 * Bambu Studio writes user presets with JSON.stringify-compatible layout (4-space indent), but
 * line endings and the trailing newline vary from file to file, and a few hand-edited system
 * files are not canonical at all. Fixes should therefore use the minimal-edit helpers
 * (setJsonStringField / setJsonArrayStringItem), which change only the bytes of one value.
 */
import { errorMessage } from './fs.js';

export interface JsonFormat {
  /** Indent unit, e.g. four spaces. */
  indent: string;
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
  bom: boolean;
  /** True when serializeJsonFile(value, format) reproduces the original text exactly. */
  canonical: boolean;
}

export interface ParsedJsonFile {
  value: unknown;
  format: JsonFormat;
}

/** Format Bambu Studio uses for user presets it writes itself. */
export const DEFAULT_JSON_FORMAT: JsonFormat = {
  indent: '    ',
  eol: '\n',
  trailingNewline: false,
  bom: false,
  canonical: true,
};

export class JsonFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonFileError';
  }
}

// Written as an escape so the source stays plain ASCII.
const BOM = '\uFEFF';

/** The text without a leading byte order mark, if it has one. */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** A JSON object: not null, not an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function detectJsonFormat(text: string): Omit<JsonFormat, 'canonical'> {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const nl = body.indexOf('\n');
  const eol = nl > 0 && body[nl - 1] === '\r' ? '\r\n' : '\n';
  const indent = /^[[{][ \t]*\r?\n([ \t]+)\S/.exec(body)?.[1] ?? DEFAULT_JSON_FORMAT.indent;
  return { indent, eol, trailingNewline: body.endsWith('\n'), bom };
}

/** Parses a JSON file and records its formatting. Throws JsonFileError on invalid JSON. */
export function parseJsonFile(text: string): ParsedJsonFile {
  const base = detectJsonFormat(text);
  let value: unknown;
  try {
    value = JSON.parse(base.bom ? text.slice(1) : text);
  } catch (err) {
    throw new JsonFileError(errorMessage(err));
  }
  const format: JsonFormat = { ...base, canonical: false };
  format.canonical = serializeJsonFile(value, format) === text;
  return { value, format };
}

export type TryParseResult = ({ ok: true } & ParsedJsonFile) | { ok: false; error: string };

export function tryParseJsonFile(text: string): TryParseResult {
  try {
    return { ok: true, ...parseJsonFile(text) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export function serializeJsonFile(
  value: unknown,
  format: JsonFormat = DEFAULT_JSON_FORMAT,
): string {
  // JSON.stringify escapes newlines inside strings, so every '\n' here is structural.
  const body = JSON.stringify(value, null, format.indent).replace(/\n/g, format.eol);
  return (format.bom ? BOM : '') + body + (format.trailingNewline ? format.eol : '');
}

/**
 * Replaces the string value of a top-level key, touching only that value's bytes.
 * Throws if the key is missing, duplicated, or not a string.
 */
export function setJsonStringField(text: string, key: string, newValue: string): string {
  const tokens = tokenize(text);
  const v = topLevelValue(text, tokens, key);
  const tok = tokens[v];
  if (tok?.kind !== 'string') throw new JsonFileError(`"${key}" is not a string`);
  return splice(text, tok, newValue);
}

/** Replaces item `index` of a top-level string array, e.g. filament_settings_id[0]. */
export function setJsonArrayStringItem(
  text: string,
  key: string,
  index: number,
  newValue: string,
): string {
  const tokens = tokenize(text);
  const open = topLevelValue(text, tokens, key);
  if (tokens[open]?.kind !== '[') throw new JsonFileError(`"${key}" is not an array`);
  let depth = 0;
  let item = 0;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (depth === 0 && item === index && t.kind !== ']' && t.kind !== ',') {
      if (t.kind !== 'string') throw new JsonFileError(`"${key}"[${index}] is not a string`);
      return splice(text, t, newValue);
    }
    if (t.kind === '[' || t.kind === '{') depth++;
    else if (t.kind === ']' || t.kind === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && t.kind === ',') item++;
  }
  throw new JsonFileError(`"${key}" has no item ${index}`);
}

/**
 * Sets a top-level key to an array of strings, written as Studio writes arrays (one item per
 * line, the file's own indent and line ending). An existing array is replaced in place; a missing
 * key is added where Studio's sorted key order puts it (before the first key that sorts after
 * it), so only that key's lines change. Throws if the key is duplicated or holds a non-array.
 */
export function setJsonStringArray(text: string, key: string, values: readonly string[]): string {
  const tokens = tokenize(text);
  const fields = topLevelFields(text, tokens);
  const { indent, eol } = detectJsonFormat(text);
  const array =
    values.length === 0
      ? '[]'
      : `[${eol}${values.map((v) => `${indent}${indent}${JSON.stringify(v)}`).join(`,${eol}`)}${eol}${indent}]`;
  const hits = fields.filter((f) => f.key === key);
  if (hits.length > 1) throw new JsonFileError(`Key "${key}" appears more than once`);
  if (hits.length === 1) {
    const open = hits[0]!.valueIndex;
    if (tokens[open]?.kind !== '[') throw new JsonFileError(`"${key}" is not an array`);
    const close = matchingClose(tokens, open);
    return text.slice(0, tokens[open]!.start) + array + text.slice(tokens[close]!.end);
  }
  const field = `${JSON.stringify(key)}: ${array}`;
  // Plain code-unit order, as std::map<std::string> sorts Studio's keys.
  const next = fields.find((f) => f.key > key);
  if (next) {
    const keyToken = tokens[next.valueIndex - 2]!;
    return `${text.slice(0, keyToken.start)}${field},${eol}${indent}${text.slice(keyToken.start)}`;
  }
  const last = fields.at(-1);
  if (!last) throw new JsonFileError('The object has no keys');
  const lastToken = tokens[last.valueIndex]!;
  const end =
    lastToken.kind === '[' || lastToken.kind === '{'
      ? tokens[matchingClose(tokens, last.valueIndex)]!.end
      : lastToken.end;
  return `${text.slice(0, end)},${eol}${indent}${field}${text.slice(end)}`;
}

/** The index of the bracket that closes the one at `open`. */
function matchingClose(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const k = tokens[i]!.kind;
    if (k === '[' || k === '{') depth++;
    else if (k === ']' || k === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new JsonFileError('Unbalanced brackets');
}

/** Decoded top-level keys in file order (useful for checks that care about key order). */
export function topLevelKeys(text: string): string[] {
  const tokens = tokenize(text);
  return topLevelFields(text, tokens).map((f) => f.key);
}

interface Token {
  kind: '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'literal';
  start: number;
  end: number;
}

function splice(text: string, tok: Token, newValue: string): string {
  return text.slice(0, tok.start) + JSON.stringify(newValue) + text.slice(tok.end);
}

function topLevelValue(text: string, tokens: Token[], key: string): number {
  const hits = topLevelFields(text, tokens).filter((f) => f.key === key);
  if (hits.length === 0) throw new JsonFileError(`Key "${key}" not found`);
  if (hits.length > 1) throw new JsonFileError(`Key "${key}" appears more than once`);
  return hits[0]!.valueIndex;
}

function topLevelFields(text: string, tokens: Token[]): { key: string; valueIndex: number }[] {
  if (tokens[0]?.kind !== '{') throw new JsonFileError('Top level is not an object');
  const fields: { key: string; valueIndex: number }[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === '{' || t.kind === '[') depth++;
    else if (t.kind === '}' || t.kind === ']') depth--;
    else if (depth === 1 && t.kind === 'string' && tokens[i + 1]?.kind === ':') {
      fields.push({ key: JSON.parse(text.slice(t.start, t.end)) as string, valueIndex: i + 2 });
      i++;
    }
  }
  return fields;
}

// Lexer only: callers are expected to have validated the text with JSON.parse already,
// but it still refuses unterminated strings so a bad file can never be silently mangled.
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = text.startsWith(BOM) ? 1 : 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
    } else if ('{}[]:,'.includes(c)) {
      tokens.push({ kind: c as Token['kind'], start: i, end: i + 1 });
      i++;
    } else if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (i >= text.length) throw new JsonFileError('Unterminated string');
      tokens.push({ kind: 'string', start, end: ++i });
    } else {
      const start = i;
      while (i < text.length && !/[\s{}[\]:,"]/.test(text[i]!)) i++;
      tokens.push({ kind: 'literal', start, end: i });
    }
  }
  return tokens;
}
