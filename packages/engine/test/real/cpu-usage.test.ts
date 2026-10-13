// real/cpu-usage.ts（#1980）：读会话 scope 的 cgroup cpu.stat，收场折成 CPU 秒数。
// 认得出的数、认不出的内容、文件不在、读到 0，每条都故意造一次：读不成一律不给数、写明原因（不拿 0 顶）。
import { describe, expect, it } from 'vitest';
import {
  type CpuUsageDeps,
  cpuSecondsFromUsec,
  parseCpuUsageUsec,
  sampleCpuUsage,
  scopeCpuStatPath,
} from '../../src/real/cpu-usage.ts';

const deps = (readText: CpuUsageDeps['readText']): CpuUsageDeps => ({
  readText,
  cgroupRoot: '/sys/fs/cgroup',
  slicePath: 'fleet.slice/fleet-agents.slice',
  intervalMs: 5,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const stat = (usec: number) => `usage_usec ${usec}\nuser_usec 1\nsystem_usec 1\n`;

describe('parseCpuUsageUsec', () => {
  it('取 usage_usec', () => {
    expect(parseCpuUsageUsec(stat(720_000_000))).toBe(720_000_000);
  });
  it('【故意造出的失败】没有这一行、是 0、空、带单位：都抛，不当成数', () => {
    for (const bad of ['user_usec 1\n', stat(0), '', 'usage_usec 12s\n']) {
      expect(() => parseCpuUsageUsec(bad), bad).toThrow(/usage_usec/);
    }
  });
});

describe('cpuSecondsFromUsec', () => {
  it('向上取整成秒；0 和认不出的不给数', () => {
    expect(cpuSecondsFromUsec(720_000_000)).toBe(720);
    expect(cpuSecondsFromUsec(1)).toBe(1);
    expect(cpuSecondsFromUsec(1_000_001)).toBe(2);
    expect(cpuSecondsFromUsec(0)).toBeUndefined();
  });
});

describe('sampleCpuUsage', () => {
  it('取读成的最大一次，收场再读一次；路径是这个会话自己的 scope', async () => {
    const seen: string[] = [];
    const values = [50_000_000, 120_000_000, 80_000_000];
    let i = 0;
    const s = sampleCpuUsage(
      deps(async (p) => {
        seen.push(p);
        const usec = values[Math.min(i, values.length - 1)] ?? 0;
        i += 1;
        return stat(usec);
      }),
      'abc-1',
    );
    await wait(30);
    expect(await s.stop()).toEqual({ seconds: 120 });
    expect(seen[0]).toBe(
      scopeCpuStatPath(
        deps(async () => ''),
        'abc-1',
      ),
    );
    expect(seen[0]).toContain('fleet-agent-abc-1.scope/cpu.stat');
    expect(seen.length).toBeGreaterThan(1);
  });

  it('前面几次文件还不在、收场那次读成了：照样给数', async () => {
    let i = 0;
    const s = sampleCpuUsage(
      deps(async () => {
        if (i++ < 2) throw enoent();
        return stat(90_000_000);
      }),
      'x',
    );
    await wait(20);
    expect(await s.stop()).toEqual({ seconds: 90 });
  });

  it('读成过一次之后 scope 收走了（ENOENT）：用读成的那次，不算失败', async () => {
    let i = 0;
    const s = sampleCpuUsage(
      deps(async () => {
        if (i++ === 0) return stat(64_000_000);
        throw enoent();
      }),
      'x',
    );
    await wait(20);
    expect(await s.stop()).toEqual({ seconds: 64 });
  });

  it('【故意造出的失败】从头到尾不在，或一直是 0：不给秒数', async () => {
    const missing = sampleCpuUsage(
      deps(async () => {
        throw enoent();
      }),
      'x',
    );
    const zero = sampleCpuUsage(
      deps(async () => stat(0)),
      'y',
    );
    const a = await missing.stop();
    const b = await zero.stop();
    expect(a.seconds).toBeUndefined();
    expect(a.why).toContain('一直不在');
    expect(b.seconds).toBeUndefined();
    expect(b.why).toContain('CPU 秒数没读成');
  });
});
