// real/scope-oom-evidence.ts（#3448）：会话 scope 自己的内存事件见证。
// 用脚本化的假 cgroup 文件（不碰真 /sys/fs/cgroup）：采样间隔给得很大，只有「起采样那一读」和「收场那一读」两次，次序确定。
// 每条读不成、对不上的路径故意造一次：都要落成 unknown / partial，不吞成「没有事件」。
import { describe, expect, it } from 'vitest';
import {
  parseScopeOomCounts,
  type ScopeOomDeps,
  type ScopeOomEvidence,
  sampleScopeOom,
  scopeEventsPath,
  unavailableScopeOom,
} from '../../src/real/scope-oom-evidence.ts';

const SLICE = {
  cgroupRoot: '/sys/fs/cgroup',
  slicePath: 'fleet.slice/fleet-agents.slice',
};
const SCOPE = '/sys/fs/cgroup/fleet.slice/fleet-agents.slice/fleet-agent-run-1.scope';
const LOCAL = `${SCOPE}/memory.events.local`;
const TREE = `${SCOPE}/memory.events`;
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
const events = (oom: number, kill: number) =>
  `low 0\nhigh 0\nmax ${oom}\noom ${oom}\noom_kill ${kill}\noom_group_kill 0\n`;

type Step = string | Error;
/** 每个路径一串读数，读一次出一个，最后一个一直重复；没脚本的路径读出 ENOENT。 */
function fake(script: Record<string, Step[]>): { deps: ScopeOomDeps; seen: string[] } {
  const seen: string[] = [];
  const index = new Map<string, number>();
  const deps: ScopeOomDeps = {
    ...SLICE,
    intervalMs: 3_600_000,
    now: () => new Date('2026-10-21T01:02:03.000Z'),
    async readText(path) {
      seen.push(path);
      const steps = script[path];
      if (!steps) throw enoent();
      const i = Math.min(index.get(path) ?? 0, steps.length - 1);
      index.set(path, (index.get(path) ?? 0) + 1);
      const step = steps[i] as Step;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { deps, seen };
}

const sample = (deps: ScopeOomDeps, window?: 'start' | 'attach') =>
  sampleScopeOom(deps, { runId: 'run-1', scopeId: 'run-1', ...(window ? { window } : {}) });

describe('parseScopeOomCounts', () => {
  it('取 oom 和 oom_kill，别的 key 忽略', () => {
    expect(parseScopeOomCounts(events(2, 3))).toEqual({ oomEvents: 2, killedProcs: 3 });
  });
  it('【故意造出的失败】缺项、重复、负数/带单位、行认不出：都抛', () => {
    for (const bad of [
      'oom 1\n',
      'oom_kill 1\n',
      '',
      'oom 1\noom 2\noom_kill 0\n',
      'oom -1\noom_kill 0\n',
      'oom 1x\noom_kill 0\n',
      'oom 1\noom_kill 0\nrubbish\n',
      `oom ${'9'.repeat(30)}\noom_kill 0\n`,
    ]) {
      expect(() => parseScopeOomCounts(bad), bad).toThrow(/memory\.events/);
    }
  });
});

describe('sampleScopeOom', () => {
  it('同一 scope 起读为 0、收场那一读看到事件：见证留着 scope 身份、观测时刻、本地计数和来源，完整，终止来源 unknown', async () => {
    const { deps, seen } = fake({
      [LOCAL]: [events(0, 0), events(1, 1)],
    });
    const s = sample(deps);
    const ev = await s.stop();
    expect(ev).toMatchObject({
      verdict: 'oom_events_in_scope',
      integrity: 'complete',
      runId: 'run-1',
      scope: 'fleet-agent-run-1.scope',
      source: 'memory.events.local',
      sourcePath: LOCAL,
      window: 'start',
      reads: 2,
      finalRead: 'ok',
      baseline: { oomEvents: 0, killedProcs: 0 },
      last: { oomEvents: 1, killedProcs: 1 },
      delta: { oomEvents: 1, killedProcs: 1 },
      observedAt: '2026-10-21T01:02:03.000Z',
      killTarget: 'unknown',
    });
    expect(ev.note).toContain('终止来源未知');
    expect(seen.every((p) => p.startsWith(`${SCOPE}/`))).toBe(true);
  });

  it('收场那一读文件已不在：保留跑着时读到的数，partial，不能说「没有事件」', async () => {
    const { deps } = fake({ [LOCAL]: [events(0, 0), enoent()] });
    const ev = await sample(deps).stop();
    expect(ev).toMatchObject({ verdict: 'unknown', integrity: 'partial', finalRead: 'gone' });
    expect(ev.problems.join()).toContain('收场时文件已不在');
    expect(ev.baseline).toEqual({ oomEvents: 0, killedProcs: 0 });
  });

  it('无事件且读取完整：none_observed / complete；层级计数单列，不参与判断', async () => {
    const { deps } = fake({ [LOCAL]: [events(0, 0)], [TREE]: [events(0, 0)] });
    const ev = await sample(deps).stop();
    expect(ev).toMatchObject({
      verdict: 'none_observed',
      integrity: 'complete',
      delta: { oomEvents: 0, killedProcs: 0 },
      hierarchical: { oomEvents: 0, killedProcs: 0 },
      problems: [],
    });
  });

  it('层级计数（含子孙）有数、本地为 0：本地说了算，层级只单列，不顶替', async () => {
    const { deps } = fake({ [LOCAL]: [events(0, 0)], [TREE]: [events(4, 4)] });
    const ev = await sample(deps).stop();
    expect(ev.verdict).toBe('none_observed');
    expect(ev.delta).toEqual({ oomEvents: 0, killedProcs: 0 });
    expect(ev.hierarchical).toEqual({ oomEvents: 4, killedProcs: 4 });
  });

  it('父 slice、兄弟 scope 有事件：只读本 scope 自己的两个文件，混不进来', async () => {
    const parent = '/sys/fs/cgroup/fleet.slice/fleet-agents.slice/memory.events.local';
    const sibling =
      '/sys/fs/cgroup/fleet.slice/fleet-agents.slice/fleet-agent-run-2.scope/memory.events.local';
    const { deps, seen } = fake({
      [LOCAL]: [events(0, 0)],
      [parent]: [events(9, 9)],
      [sibling]: [events(7, 7)],
    });
    const ev = await sample(deps).stop();
    expect(ev.verdict).toBe('none_observed');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === LOCAL || p === TREE)).toBe(true);
    expect(scopeEventsPath(SLICE, 'run-1')).toBe(LOCAL);
  });

  it('【故意造出的失败】文件从头到尾不在：unknown / unknown，写明原因，不当成没有事件', async () => {
    const { deps } = fake({});
    const ev = await sample(deps).stop();
    expect(ev).toMatchObject({ verdict: 'unknown', integrity: 'unknown', reads: 0 });
    expect(ev.missingBeforeFirstRead).toBeGreaterThan(0);
    expect(ev.baseline).toBeUndefined();
    expect(ev.problems.join()).toContain('从头到尾都不在');
  });

  it('【故意造出的失败】拒绝读取：unknown，原因带路径和报错', async () => {
    const { deps } = fake({ [LOCAL]: [eacces()] });
    const ev = await sample(deps).stop();
    expect(ev).toMatchObject({ verdict: 'unknown', integrity: 'unknown' });
    expect(ev.problems.join()).toContain('EACCES');
    expect(ev.problems.join()).toContain(LOCAL);
  });

  it('【故意造出的失败】内容非法（缺项、乱码）：unknown，不当成 0', async () => {
    for (const bad of ['oom 0\n', 'max\n', '', 'oom a\noom_kill b\n']) {
      const { deps } = fake({ [LOCAL]: [bad] });
      const ev = await sample(deps).stop();
      expect(ev, bad).toMatchObject({ verdict: 'unknown', integrity: 'unknown' });
      expect(ev.problems.length).toBeGreaterThan(0);
    }
  });

  it('【故意造出的失败】起读好、收场那一读内容非法：partial，计数不动也只能说 unknown', async () => {
    const { deps } = fake({ [LOCAL]: [events(0, 0), 'oom 0\n'] });
    const ev = await sample(deps).stop();
    expect(ev).toMatchObject({ verdict: 'unknown', integrity: 'partial', finalRead: 'failed' });
  });

  it('【故意造出的失败】计数回退（可能是别的 scope 重用同一个名字）：unknown，原因写明回退，不拿大的那次当证据', async () => {
    const { deps } = fake({ [LOCAL]: [events(3, 3), events(1, 1)] });
    const ev = await sample(deps).stop();
    expect(ev.verdict).toBe('unknown');
    expect(ev.integrity).toBe('partial');
    expect(ev.problems.join()).toContain('回退');
  });

  it('【故意造出的失败】首读计数就不是 0（scope 重用，或首读前已发生）：不认作这次运行的事件，计数照记', async () => {
    const { deps } = fake({ [LOCAL]: [events(2, 2)] });
    const ev = await sample(deps).stop();
    expect(ev.verdict).toBe('unknown');
    expect(ev.baseline).toEqual({ oomEvents: 2, killedProcs: 2 });
    expect(ev.problems.join()).toContain('首读时计数就不是 0');
  });

  it('接回后才开始读：窗口写 attach，完整性最多 partial，没事件也不说 none_observed', async () => {
    const { deps } = fake({ [LOCAL]: [events(0, 0)] });
    const ev = await sample(deps, 'attach').stop();
    expect(ev).toMatchObject({ window: 'attach', integrity: 'partial', verdict: 'unknown' });
  });

  it('stop 之后不再读；重复 stop 返回同一份', async () => {
    const { deps, seen } = fake({ [LOCAL]: [events(0, 0)] });
    const s = sample(deps);
    const a = await s.stop();
    const n = seen.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.stop()).toBe(a);
    expect(seen.length).toBe(n);
  });

  it('跑着时一直在采（间隔内）：用真定时器读到事件，收场后文件没了，见证仍有事件', async () => {
    let n = 0;
    const deps: ScopeOomDeps = {
      ...SLICE,
      intervalMs: 5,
      async readText(path) {
        if (path !== LOCAL) throw enoent();
        n += 1;
        if (n <= 2) return events(0, 0);
        if (n <= 6) return events(1, 1);
        throw enoent();
      },
    };
    const s = sample(deps);
    await new Promise((r) => setTimeout(r, 150));
    const ev = await s.stop();
    expect(ev).toMatchObject({
      verdict: 'oom_events_in_scope',
      integrity: 'partial',
      finalRead: 'gone',
      delta: { oomEvents: 1, killedProcs: 1 },
    });
  });

  it('各种结论的文字、字段都不会触发 failure/rules.ts 的 oom_killed 文本判法', async () => {
    const cases: ScopeOomEvidence[] = [
      await sample(fake({ [LOCAL]: [events(0, 0), events(1, 1)] }).deps).stop(),
      await sample(fake({ [LOCAL]: [events(0, 0)] }).deps).stop(),
      await sample(fake({}).deps).stop(),
      await sample(fake({ [LOCAL]: [eacces()] }).deps).stop(),
      await sample(fake({ [LOCAL]: ['oom_kill 1\n'] }).deps).stop(),
      await sample(fake({ [LOCAL]: [events(3, 3), events(1, 1)] }).deps).stop(),
      unavailableScopeOom('run-1', 'run-1', 'unsupported', 'Mirasim 不支持'),
    ];
    for (const ev of cases) {
      expect(JSON.stringify(ev)).not.toMatch(/oom[-_ ]?kill|out of memory/i);
    }
  });
});
