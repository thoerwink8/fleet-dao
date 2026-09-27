// 会话被信号杀掉时按证据写是谁杀的（real/kill-evidence.ts）：引擎收到停机信号的那一刻 → engine_stop；cgroup 里有按内存杀进程
// 的记录 → oom_killed；都对不上 → signal_unexplained，写明查了什么。读不成的照实写没读成，不当成 0。
import { describe, expect, it } from 'vitest';
import type { Cordon } from '../../src/drain.ts';
import { classifyFailure } from '../../src/failure/classify.ts';
import {
  explainKill,
  type KillEvidenceDeps,
  killSignal,
  oomCounters,
  parseOomKill,
  scopeOomKills,
} from '../../src/real/kill-evidence.ts';

const T = Date.parse('2026-09-27T19:28:51.000Z');
const EVENTS = (n: number) => `low 0\nhigh 12\nmax 0\noom 1\noom_kill ${n}\noom_group_kill 0\n`;

function deps(files: Record<string, string>, lock: boolean | 'unknown' = false): KillEvidenceDeps {
  return {
    readText: async (path) => {
      const hit = Object.entries(files).find(([k]) => path.replaceAll('\\', '/').endsWith(k));
      if (!hit) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return hit[1];
    },
    releaseLockBusy: async () => (lock === 'unknown' ? undefined : lock),
    cgroupRoot: '/sys/fs/cgroup',
    slicePath: 'fleet.slice/fleet-agents.slice',
    releasesDir: '/srv/fleet-dao-releases',
  };
}
const SLICE = 'fleet-agents.slice/memory.events';
const signal = (since: number): Cordon => ({
  source: 'signal',
  since: new Date(since).toISOString(),
  until: new Date(since + 600_000).toISOString(),
  why: '收到 SIGTERM（systemd 在停引擎：发布切版本、重启或关机）',
});
const base = { signal: 'SIGTERM', endedAt: T, scopeSeen: undefined, othersRunning: 0 };

describe('读计数', () => {
  it('认得出 oom_kill 那一行；没有、认不出都抛，写明是什么，不写那个英文名', () => {
    expect(parseOomKill(EVENTS(3))).toBe(3);
    expect(() => parseOomKill('low 0\n')).toThrow('按内存杀进程');
    try {
      parseOomKill('');
    } catch (err) {
      expect(String(err)).not.toMatch(/oom_kill/);
    }
  });

  it('读不成照实带原因（不当成 0）', async () => {
    const c = await oomCounters(deps({}));
    expect(c.slice).toBeUndefined();
    expect(c.sliceWhy).toContain('没读成');
    expect((await oomCounters(deps({ [SLICE]: EVENTS(2) }))).slice).toBe(2);
  });

  it('scope 名不像 scope 的不读；读不到是 undefined', async () => {
    expect(await scopeOomKills(deps({ 'x.scope/memory.events': EVENTS(1) }), '../etc')).toBeUndefined();
    expect(
      await scopeOomKills(deps({ 'fleet-agent-1.scope/memory.events': EVENTS(1) }), 'fleet-agent-1.scope'),
    ).toBe(1);
    expect(await scopeOomKills(deps({}), 'fleet-agent-2.scope')).toBeUndefined();
  });

  it('信号：有信号看信号，没有看 128+信号 的退出码', () => {
    expect(killSignal(null, 'sigterm')).toBe('SIGTERM');
    expect(killSignal(143, null)).toBe('SIGTERM');
    expect(killSignal(137, undefined)).toBe('SIGKILL');
    expect(killSignal(1, null)).toBeNull();
    expect(killSignal(143, 'SIGINT')).toBeNull();
  });
});

describe('是谁杀的', () => {
  it('那一刻引擎收到过停机信号 → engine_stop，写上发布锁、自动发布在发哪个', async () => {
    const d = deps(
      {
        [SLICE]: EVENTS(0),
        '.auto/state.json': JSON.stringify({
          attempt: { sha: 'f'.repeat(40), result: 'running', startedAt: 'x' },
        }),
      },
      true,
    );
    const cause = await explainKill(d, { ...base, stopping: signal(T - 1000), before: { slice: 0 } });
    expect(cause.code).toBe('engine_stop');
    expect(cause.why).toContain('发布锁占着');
    expect(cause.why).toContain('ffffffffffff');
  });

  it('只是在为发布排空（请求来的、没收到停机信号）不算引擎停机：往下查，写明在排空', async () => {
    const release: Cordon = { ...signal(T - 60_000), source: 'release', why: '发布 aaaaaaaaaaaa（auto）' };
    const cause = await explainKill(deps({ [SLICE]: EVENTS(0), '.auto/state.json': '{}' }), {
      ...base,
      stopping: release,
      before: { slice: 0 },
    });
    expect(cause.code).toBe('signal_unexplained');
    expect(cause.why).toContain('在为发布排空');
  });

  it('停机信号在进程退出之后很久才来：不算', async () => {
    const cause = await explainKill(deps({ [SLICE]: EVENTS(0), '.auto/state.json': '{}' }), {
      ...base,
      stopping: signal(T + 60_000),
      before: { slice: 0 },
    });
    expect(cause.code).toBe('signal_unexplained');
  });

  it('会话自己的 cgroup 记过按内存杀进程 → oom_killed', async () => {
    const cause = await explainKill(deps({ [SLICE]: EVENTS(1) }), {
      ...base,
      signal: 'SIGKILL',
      stopping: null,
      before: { slice: 1 },
      scopeSeen: 1,
    });
    expect(cause.code).toBe('oom_killed');
  });

  it('资源池这段时间涨了、只有它在跑 → oom_killed；还有别的会话在跑 → 归不到它，写明', async () => {
    const d = deps({ [SLICE]: EVENTS(4), '.auto/state.json': '{}' });
    expect((await explainKill(d, { ...base, stopping: null, before: { slice: 3 } })).code).toBe('oom_killed');
    const shared = await explainKill(d, { ...base, stopping: null, before: { slice: 3 }, othersRunning: 2 });
    expect(shared.code).toBe('signal_unexplained');
    expect(shared.why).toContain('归不到是不是它');
  });

  it('都对不上：没查到是谁杀的；内存那一项读不成照实写没查成', async () => {
    const d = deps({ '.auto/state.json': '{}' }, 'unknown');
    const cause = await explainKill(d, {
      ...base,
      stopping: null,
      before: { slice: undefined, sliceWhy: '/sys/fs/cgroup/... 没读成（EACCES）' },
    });
    expect(cause.code).toBe('signal_unexplained');
    expect(cause.why).toContain('没查到是谁杀的');
    expect(cause.why).toContain('内存那一项没查成');
    expect(cause.why).toContain('发布锁没查成');
    expect(cause.why).not.toMatch(/oom_kill/);
  });

  it('交给失败分流：三个码各认成各自的规则，不再写死「多半是内存超限」', async () => {
    const d = deps({ [SLICE]: EVENTS(0), '.auto/state.json': '{}' });
    const unexplained = await explainKill(d, { ...base, stopping: null, before: { slice: 0 } });
    const rule = (code: string, why: string) =>
      classifyFailure({
        source: 'session:execute',
        routeId: 'r',
        code,
        exitCode: 143,
        message: `进程退出（退出码 143），没有终帧；${why}`,
        now: new Date(T).toISOString(),
      });
    const r = rule(unexplained.code, unexplained.why);
    expect(r.rule).toBe('KL4');
    expect(JSON.stringify(r)).not.toContain('多半是内存超限');
    const stop = await explainKill(d, { ...base, stopping: signal(T), before: { slice: 0 } });
    expect(rule(stop.code, stop.why).rule).toBe('KL3');
  });
});
