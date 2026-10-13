// root 写进 fleet 目录的状态文件要改回目录属主（法国读回「root 属主的文件」红）。
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeAtomicOwnedByDir } from '../src/write-owned-by-dir.ts';

describe('writeAtomicOwnedByDir', () => {
  it('写完把属主改成目录的属主，用的是临时文件、换名前改', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owned-'));
    const calls: Array<[string, number, number]> = [];
    const file = join(dir, 'state.json');
    await writeAtomicOwnedByDir(file, '{"a":1}\n', async (p, u, g) => {
      calls.push([p, u, g]);
    });
    const st = await stat(dir);
    if (st.uid === 0) {
      // 本身是 root 的环境：目录归 root，不改
      expect(calls).toEqual([]);
    } else {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toMatch(/state\.json\.\d+\.tmp$/);
      expect([calls[0]?.[1], calls[0]?.[2]]).toEqual([st.uid, st.gid]);
    }
    expect(await readFile(file, 'utf8')).toBe('{"a":1}\n');
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('改属主失败就报错，不换上半成品', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owned-'));
    const st = await stat(dir);
    if (st.uid === 0) return; // root 环境不会走到改属主
    const file = join(dir, 'state.json');
    await expect(
      writeAtomicOwnedByDir(file, 'x', async () => {
        throw new Error('EPERM');
      }),
    ).rejects.toThrow('EPERM');
    expect(await readdir(dir)).not.toContain('state.json');
  });
});
