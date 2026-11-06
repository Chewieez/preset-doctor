import { describe, expect, it } from 'vitest';
import { memFs } from './memFs.js';
import { describePresetFsContract } from './testing/fsContract.js';

describePresetFsContract('memFs', async (initial) => memFs(initial));

describe('memFs', () => {
  it('accepts binary initial content', async () => {
    const fs = memFs({ 'a.bin': new Uint8Array([1, 2, 3]) });
    expect(Array.from(await fs.readBytes('a.bin'))).toEqual([1, 2, 3]);
  });

  it('snapshot returns every file as text', async () => {
    const fs = memFs({ 'a/x.json': '{}' });
    await fs.writeText('b.info', 'k = v');
    expect(fs.snapshot()).toEqual({ 'a/x.json': '{}', 'b.info': 'k = v' });
  });

  it('isolates stored bytes from caller mutations', async () => {
    const data = new Uint8Array([1, 2]);
    const fs = memFs();
    await fs.writeBytes('f', data);
    data[0] = 9;
    const read = await fs.readBytes('f');
    read[1] = 9;
    expect(Array.from(await fs.readBytes('f'))).toEqual([1, 2]);
  });

  it('refuses to remove the root and to write over a folder', async () => {
    const fs = memFs({ 'd/f': '' });
    await expect(fs.remove('')).rejects.toThrow();
    await expect(fs.writeText('d', 'x')).rejects.toThrow();
  });
});
