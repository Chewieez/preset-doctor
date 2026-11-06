/** Unified line diffs of planned changes, for the CLI dry run and the apps' review step. */
import type { Change } from './types.js';

export interface DiffOptions {
  /** Unchanged lines shown around each change. Default 3. */
  context?: number;
}

/** A unified diff of one change, for display. Line endings are not shown. */
export function unifiedDiff(change: Change, options: DiffOptions = {}): string {
  const context = options.context ?? 3;
  const a = splitLines(change.before);
  const b = splitLines(change.after);
  const ops = diffLines(a, b);
  const out = [`--- a/${change.path}`, `+++ b/${change.path}`];

  // Positions (in a and b) before each op, for hunk headers.
  const posA: number[] = [];
  const posB: number[] = [];
  let ia = 0;
  let ib = 0;
  for (const op of ops) {
    posA.push(ia);
    posB.push(ib);
    if (op.kind !== '+') ia++;
    if (op.kind !== '-') ib++;
  }

  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === ' ') {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    // Extend over changes that are close enough to share context.
    for (let j = i; j < ops.length; j++) {
      if (ops[j]!.kind !== ' ') end = j;
      else if (j - end > 2 * context) break;
    }
    const stop = Math.min(ops.length - 1, end + context);
    const slice = ops.slice(start, stop + 1);
    const lenA = slice.filter((o) => o.kind !== '+').length;
    const lenB = slice.filter((o) => o.kind !== '-').length;
    const startA = lenA === 0 ? posA[start]! : posA[start]! + 1;
    const startB = lenB === 0 ? posB[start]! : posB[start]! + 1;
    out.push(`@@ -${startA},${lenA} +${startB},${lenB} @@`);
    for (const o of slice) out.push(o.kind + o.line);
    i = stop + 1;
  }
  return out.join('\n');
}

interface DiffOp {
  kind: ' ' | '-' | '+';
  line: string;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line diff: common prefix and suffix, then an LCS table over what is left. */
function diffLines(a: string[], b: string[]): DiffOp[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const ops: DiffOp[] = a.slice(0, pre).map((line) => ({ kind: ' ', line }));

  if (midA.length * midB.length > 4_000_000) {
    // Too big for a table; a single replace block is still a correct diff.
    for (const line of midA) ops.push({ kind: '-', line });
    for (const line of midB) ops.push({ kind: '+', line });
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        lcs[x]![y] =
          midA[x] === midB[y]
            ? lcs[x + 1]![y + 1]! + 1
            : Math.max(lcs[x + 1]![y]!, lcs[x]![y + 1]!);
      }
    }
    let x = 0;
    let y = 0;
    while (x < n || y < m) {
      if (x < n && y < m && midA[x] === midB[y]) {
        ops.push({ kind: ' ', line: midA[x++]! });
        y++;
      } else if (x < n && (y === m || lcs[x + 1]![y]! >= lcs[x]![y + 1]!)) {
        // Removals before additions, as diff tools show them.
        ops.push({ kind: '-', line: midA[x++]! });
      } else {
        ops.push({ kind: '+', line: midB[y++]! });
      }
    }
  }
  for (const line of a.slice(a.length - suf)) ops.push({ kind: ' ', line });
  return ops;
}
