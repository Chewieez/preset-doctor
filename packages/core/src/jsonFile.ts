/**
 * Read and write preset JSON without disturbing its formatting.
 *
 * Bambu Studio writes user presets with JSON.stringify-compatible layout (4-space indent), but
 * line endings and the trailing newline vary from file to file, and a few hand-edited system
 * files are not canonical at all. Fixes should therefore use the minimal-edit helpers
 * (setJsonStringField / setJsonArrayStringItem), which change only the bytes of one value.
 */

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

const BOM = '﻿';

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
    throw new JsonFileError((err as Error).message);
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
    return { ok: false, error: (err as Error).message };
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
