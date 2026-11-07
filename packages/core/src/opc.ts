/**
 * OrcaSlicer 2.5's packed system presets, system/<Vendor>.opc. Its Windows build ships these
 * instead of the JSON files (.github/workflows/build_orca.yml:522-527@v2.5.0), and installing one
 * removes system/<Vendor>.json and system/<Vendor>/ (src/slic3r/Utils/PresetUpdater.cpp:147-163@v2.5.0).
 *
 * The file is a 20-byte header {u32 magic 0x4F52435A "ORCZ", u32 version, u64 body size, u32 CRC-32
 * of the body}, all little-endian, then an uncompressed cereal binary body
 * (src/libslic3r/PresetCacheFormat.cpp:317-333, 435-470@v2.5.0). Strings in the body are a u64
 * length followed by UTF-8 bytes. Preset Doctor reads no further than that: it only tests whether
 * a name occurs as such a string (docs/design-v0.2.md section 6.3), which can say "present" for a
 * name that is only some preset's parent, never "missing" for one that is there.
 */
import { encodeText } from './fs.js';

export const OPC_MAGIC = 0x4f52435a;
const HEADER_BYTES = 20;

/** A vendor that is only there as a .opc file. */
export interface OpaqueVendor {
  vendor: string;
  /** Root-relative path, e.g. 'system/BBL.opc'. */
  path: string;
  /** False when the file could not be read or its header, size or CRC don't check out. */
  readable: boolean;
}

/** Checks magic, size and CRC, as Orca's read_cache_blob does; returns the body. */
export function readOpc(bytes: Uint8Array): { ok: true; body: Uint8Array } | { ok: false } {
  if (bytes.length < HEADER_BYTES) return { ok: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== OPC_MAGIC) return { ok: false };
  const size = view.getBigUint64(8, true);
  if (size === 0n || size !== BigInt(bytes.length - HEADER_BYTES)) return { ok: false };
  const body = bytes.subarray(HEADER_BYTES);
  if (crc32(body) !== view.getUint32(16, true)) return { ok: false };
  return { ok: true, body };
}

/** True when the body holds `s` as a cereal string: its u64 little-endian length, then its bytes. */
export function opcHasString(body: Uint8Array, s: string): boolean {
  const text = encodeText(s);
  if (text.length === 0) return false;
  const needle = new Uint8Array(8 + text.length);
  new DataView(needle.buffer).setBigUint64(0, BigInt(text.length), true);
  needle.set(text, 8);
  return indexOf(body, needle) >= 0;
}

/** Builds a .opc file around `body` (for tests and fixtures). */
export function makeOpc(body: Uint8Array, version = 2): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, OPC_MAGIC, true);
  view.setUint32(4, version, true);
  view.setBigUint64(8, BigInt(body.length), true);
  view.setUint32(16, crc32(body), true);
  out.set(body, HEADER_BYTES);
  return out;
}

/** Cereal-style strings back to back, each a u64 length then its bytes (for tests). */
export function cerealStrings(strings: readonly string[]): Uint8Array {
  const parts = strings.map((s) => encodeText(s));
  const out = new Uint8Array(parts.reduce((n, p) => n + 8 + p.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of parts) {
    view.setBigUint64(at, BigInt(p.length), true);
    out.set(p, at + 8);
    at += 8 + p.length;
  }
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  const first = needle[0];
  outer: for (let i = hay.indexOf(first!); i >= 0 && i <= hay.length - needle.length;) {
    for (let j = 1; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        i = hay.indexOf(first!, i + 1);
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

let crcTable: Uint32Array | undefined;

/** The standard CRC-32 (boost::crc_32_type, zlib's). */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
