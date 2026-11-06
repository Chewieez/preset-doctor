import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './diff.js';
import type { Change } from './types.js';

describe('unifiedDiff', () => {
  const change = (before: string, after: string): Change => ({
    path: 'p.json',
    before,
    after,
    description: '',
  });
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`);

  it('shows a one-line change with three lines of context', () => {
    const a = lines(10);
    const b = [...a];
    b[4] = 'L5';
    expect(unifiedDiff(change(a.join('\n'), b.join('\n')))).toBe(
      [
        '--- a/p.json',
        '+++ b/p.json',
        '@@ -2,7 +2,7 @@',
        ' l2',
        ' l3',
        ' l4',
        '-l5',
        '+L5',
        ' l6',
        ' l7',
        ' l8',
      ].join('\n'),
    );
  });

  it('splits distant changes into separate hunks and merges close ones', () => {
    const a = lines(30);
    const far = [...a];
    far[1] = 'X';
    far[25] = 'Y';
    expect(unifiedDiff(change(a.join('\n'), far.join('\n'))).match(/^@@/gm)).toHaveLength(2);
    const near = [...a];
    near[1] = 'X';
    near[6] = 'Y';
    expect(unifiedDiff(change(a.join('\n'), near.join('\n'))).match(/^@@/gm)).toHaveLength(1);
  });

  it('handles insertions, deletions and CRLF', () => {
    expect(unifiedDiff(change('a\r\nb\r\n', 'a\r\nb\r\nc\r\n'))).toBe(
      '--- a/p.json\n+++ b/p.json\n@@ -1,2 +1,3 @@\n a\n b\n+c',
    );
    expect(unifiedDiff(change('a\nb', 'b'))).toBe(
      '--- a/p.json\n+++ b/p.json\n@@ -1,2 +1,1 @@\n-a\n b',
    );
    expect(unifiedDiff(change('', 'x'))).toBe('--- a/p.json\n+++ b/p.json\n@@ -0,0 +1,1 @@\n+x');
    expect(unifiedDiff(change('same', 'same'))).toBe('--- a/p.json\n+++ b/p.json');
  });
});
