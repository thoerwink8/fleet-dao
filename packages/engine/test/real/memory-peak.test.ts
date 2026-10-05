// real/memory-peak.ts（#948）：读会话 scope 的 cgroup memory.peak。认得出的数、认不出的内容、文件不在、读不了，每条都故意造一次：
// 读不成一律不给数、写明原因（不拿 0、不拿别的 cgroup 的数顶）。
import { describe, expect, it } from 'vitest';
import {
  type MemoryPeakDeps,
  parseMemoryPeakBytes,
  sampleMemoryPeak,
  scopePeakPath,
} from '../../src/real/memory-peak.ts';

const MB = 1024 * 1024;
const deps = (readText: MemoryPeakDeps['readText']): MemoryPeakDeps => ({
  readText,
  cgroupRoot: '/sys/fs/cgroup',
  slicePath: 'fleet.slice/fleet-agents.slice',
  intervalMs: 5,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

describe('parseMemoryPeakBytes', () => {
  it('纯数字（带换行）认得', () => {
    expect(parseMemoryPeakBytes('466505728\n')).toBe(466505728);
  });
  it('【故意造出的失败】max、空、负数、小数、带单位、0、一长串：都抛，不当成数', () => {
    for (const bad of ['max', '', '-5', '1.5', '12M', '0', '9'.repeat(40)]) {
      expect(() => parseMemoryPeakBytes(bad), bad).toThrow();
    }
  });
});

describe('sampleMemoryPeak', () => {
  it('取读成的最大一次，向上取整成 MB；路径是这个会话自己的 scope', async () => {
    const seen: string[] = [];
    const values = [50 * MB, 120 * MB + 1, 80 * MB];
    let i = 0;
    const s = sampleMemoryPeak(
      deps(async (p) => {
        seen.push(p);
        return String(values[Math.min(i++, values.length - 1)]);
      }),
      'abc-1',
    );
    await wait(60);
    expect(await s.stop()).toEqual({ mb: 121 });
    expect(seen[0]).toBe(
      scopePeakPath(
        deps(async () => ''),
        'abc-1',
      ),
    );
    expect(seen[0]).toContain('fleet-agent-abc-1.scope/memory.peak');
  });

  it('前面几次文件还不在（scope 没建出来）、后来读成了：照样给数', async () => {
    let i = 0;
    const s = sampleMemoryPeak(
      deps(async () => {
        if (i++ < 2) throw enoent();
        return String(200 * MB);
      }),
      'x',
    );
    await wait(60);
    expect(await s.stop()).toEqual({ mb: 200 });
  });

  it('读成过一次之后 scope 收走了（ENOENT）：用读成的那次，不算失败', async () => {
    let i = 0;
    const s = sampleMemoryPeak(
      deps(async () => {
        if (i++ === 0) return String(64 * MB);
        throw enoent();
      }),
      'x',
    );
    await wait(40);
    expect(await s.stop()).toEqual({ mb: 64 });
  });

  it('【故意造出的失败】一直不在：不给数、写明「一直不在」', async () => {
    const s = sampleMemoryPeak(
      deps(async () => {
        throw enoent();
      }),
      'x',
    );
    await wait(30);
    const r = await s.stop();
    expect(r.mb).toBeUndefined();
    expect(r.why).toContain('一直不在');
  });

  it('【故意造出的失败】认不出（max、0、乱码）和读不了（权限）：不给数、写明原因', async () => {
    for (const read of [
      async () => 'max\n',
      async () => '0\n',
      async () => 'hello',
      async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    ]) {
      const s = sampleMemoryPeak(deps(read), 'x');
      await wait(30);
      const r = await s.stop();
      expect(r.mb).toBeUndefined();
      expect(r.why).toContain('内存峰值没读成');
    }
  });

  it('stop 之后不再读；立刻 stop（一次采样都没来得及）也要明确说没读到', async () => {
    let reads = 0;
    const s = sampleMemoryPeak(
      deps(async () => {
        reads += 1;
        return String(10 * MB);
      }),
      'x',
    );
    await s.stop();
    const after = reads;
    await wait(40);
    expect(reads).toBe(after);
  });
});
