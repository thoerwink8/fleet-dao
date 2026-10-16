import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Gh, RunResult } from '../src/pr-arm.ts';
import {
  collectStats,
  type PolicyLib,
  prWriterModels,
  subagentStats,
  writerLine,
  writerModelsFromTrailers,
} from '../src/subagent-stats.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const policy = (await import(
  pathToFileURL(join(ROOT, 'agents/hooks/subagent-ledger.mjs')).href
)) as PolicyLib & { policyPath(home: string): string };

const NOW = new Date('2026-10-16T12:00:00.000Z');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'subagent-stats-'));
  dirs.push(d);
  return d;
};
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });

const HAIKU_TRAILER = 'Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>';
const SONNET_TRAILER = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>';

interface FakePr {
  number: number;
  title?: string;
  body?: string;
  mergedAt: string;
  headRefName?: string;
  mergeCommit?: { oid: string };
}
const pr = (p: FakePr) => ({
  title: `PR ${p.number}`,
  body: '',
  headRefName: `local/${p.number}-x`,
  mergeCommit: { oid: `deadbee${p.number}` },
  ...p,
});
/** Haiku 开的 PR：正文写了固定的一行 */
const haikuPr = (n: number, mergedAt: string, extra: Partial<FakePr> = {}) =>
  pr({ number: n, mergedAt, body: `**做了什么**：x\n\n**写码模型**：claude-haiku-5-5\n`, ...extra });

interface World {
  prs: ReturnType<typeof pr>[];
  /** 分支 → 第一轮 CI 的结论（按时间早到晚给）；没给的分支回「没有运行」；字符串 'ERR' 表示 gh 报错 */
  runs?: Record<string, ({ conclusion: string | null; createdAt: string } | 'ERR')[]>;
  listFails?: string;
  /** 主线提交全文（合并提交 sha → 提交说明）；没给就是一条也没有 */
  commits?: Record<string, string>;
  /** 读主线提交时 gh 报的错 */
  commitsFail?: string;
}
function fakeGh(w: World): { gh: Gh; calls: string[][] } {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1]?.includes('/commits?')) {
      if (w.commitsFail) return bad(w.commitsFail);
      return ok(
        Object.entries(w.commits ?? {})
          .map(([sha, message]) => JSON.stringify({ sha, message }))
          .join('\n'),
      );
    }
    if (args[0] === 'pr' && args[1] === 'list')
      return w.listFails ? bad(w.listFails) : ok(JSON.stringify(w.prs));
    if (args[0] === 'run' && args[1] === 'list') {
      const branch = args[args.indexOf('--branch') + 1] ?? '';
      const runs = w.runs?.[branch];
      if (runs?.[0] === 'ERR') return bad('HTTP 502');
      return ok(
        JSON.stringify(
          (runs ?? []).map((r, i) => ({ databaseId: i + 1, status: 'completed', ...(r as object) })),
        ),
      );
    }
    throw new Error(`用例没料到的 gh 调用：${args.join(' ')}`);
  };
  return { gh, calls };
}

describe('认 Haiku 开的 PR：提交尾注和正文那一行', () => {
  it('尾注里的模型名折成完整 id', () => {
    expect(writerModelsFromTrailers(`改了\n\n${HAIKU_TRAILER}\n`)).toEqual(['claude-haiku-5-5']);
    expect(writerModelsFromTrailers(`x\n${SONNET_TRAILER}`)).toEqual(['claude-sonnet-5-5']);
    expect(writerModelsFromTrailers('Co-Authored-By: Claude Opus 5.5 <a@b>')).toEqual(['claude-opus-5-5']);
  });

  it('多条提交、同一个模型只列一次；不是 Claude 的尾注不算', () => {
    const text = `a\n${HAIKU_TRAILER}\n\x1eb\n${HAIKU_TRAILER}\n${SONNET_TRAILER}\n\x1ec\nCo-Authored-By: Someone <s@x>`;
    expect(writerModelsFromTrailers(text)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
  });

  it('没有尾注：空', () => {
    expect(writerModelsFromTrailers('普通提交')).toEqual([]);
  });

  it('正文那一行的固定格式', () => {
    expect(writerLine(['claude-haiku-5-5'])).toBe('**写码模型**：claude-haiku-5-5');
    expect(writerLine(['claude-haiku-5-5', 'claude-sonnet-5-5'])).toBe(
      '**写码模型**：claude-haiku-5-5、claude-sonnet-5-5',
    );
    expect(writerLine([])).toBeUndefined();
  });

  it('PR 两条路都认：正文那一行，或提交尾注', () => {
    expect(prWriterModels('**写码模型**：claude-haiku-5-5', [])).toEqual(['claude-haiku-5-5']);
    expect(prWriterModels('写码模型：claude-haiku-5-5', [])).toEqual(['claude-haiku-5-5']);
    expect(prWriterModels('', [`x\n${HAIKU_TRAILER}`])).toEqual(['claude-haiku-5-5']);
    expect(prWriterModels('没写', ['x'])).toEqual([]);
  });
});

describe('collectStats：近 30 天 Haiku 改代码的 PR 逐个算', () => {
  it('第一次 CI 绿、没人修：没返工', async () => {
    const { gh } = fakeGh({
      prs: [haikuPr(10, '2026-10-10T00:00:00Z')],
      runs: { 'local/10-x': [{ conclusion: 'success', createdAt: '2026-10-09T00:00:00Z' }] },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.problem).toBeUndefined();
    expect(s.prs).toHaveLength(1);
    expect(s.prs[0]).toMatchObject({ number: 10, ci: { state: 'green' }, repairs: [], rework: false });
    expect(s.sample).toBe(1);
    expect(s.reworked).toBe(0);
    expect(s.wrongIn).toBe(0);
  });

  it('只看第一次 CI：先红后绿算返工；后面的运行不改它', async () => {
    const { gh } = fakeGh({
      prs: [haikuPr(10, '2026-10-10T00:00:00Z')],
      runs: {
        'local/10-x': [
          { conclusion: 'failure', createdAt: '2026-10-09T00:00:00Z' },
          { conclusion: 'success', createdAt: '2026-10-09T02:00:00Z' },
        ],
      },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.prs[0]).toMatchObject({ ci: { state: 'red' }, rework: true });
    expect(s.reworked).toBe(1);
    expect(s.wrongIn).toBe(0); // 没合进去就被 CI 拦下的不算错进
  });

  it('运行列表给的顺序不对也按创建时间取最早的', async () => {
    const { gh } = fakeGh({
      prs: [haikuPr(10, '2026-10-10T00:00:00Z')],
      runs: {
        'local/10-x': [
          { conclusion: 'success', createdAt: '2026-10-09T02:00:00Z' },
          { conclusion: 'failure', createdAt: '2026-10-09T00:00:00Z' },
        ],
      },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.prs[0]?.ci.state).toBe('red');
  });

  it('合并后 7 天内有 PR 正文写「修 #N」：返工，也算错进', async () => {
    const { gh } = fakeGh({
      prs: [
        haikuPr(10, '2026-10-01T00:00:00Z'),
        pr({ number: 11, mergedAt: '2026-10-05T00:00:00Z', body: '**做了什么**：修 #10 弄坏的东西' }),
      ],
      runs: { 'local/10-x': [{ conclusion: 'success', createdAt: '2026-09-30T00:00:00Z' }] },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.prs[0]).toMatchObject({ number: 10, rework: true, repairs: [{ number: 11, how: '修' }] });
    expect(s.wrongIn).toBe(1);
  });

  it('revert 了它也算（标题带 Revert 和 #N，或正文写 This reverts commit <合并提交>）', async () => {
    const { gh } = fakeGh({
      prs: [
        haikuPr(10, '2026-10-01T00:00:00Z'),
        haikuPr(20, '2026-10-02T00:00:00Z'),
        pr({ number: 30, mergedAt: '2026-10-03T00:00:00Z', title: 'Revert "加东西 (#10)"' }),
        pr({ number: 31, mergedAt: '2026-10-04T00:00:00Z', body: 'This reverts commit deadbee20.' }),
      ],
      runs: {
        'local/10-x': [{ conclusion: 'success', createdAt: '2026-09-30T00:00:00Z' }],
        'local/20-x': [{ conclusion: 'success', createdAt: '2026-10-01T00:00:00Z' }],
      },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.prs.find((p) => p.number === 10)?.repairs).toEqual([{ number: 30, how: 'revert' }]);
    expect(s.prs.find((p) => p.number === 20)?.repairs).toEqual([{ number: 31, how: 'revert' }]);
    expect(s.wrongIn).toBe(2);
  });

  it('修它的 PR 在 7 天之外合并、或在它之前合并：不算；号码只认整数（#10 不匹配 #100）', async () => {
    const { gh } = fakeGh({
      prs: [
        haikuPr(10, '2026-10-01T00:00:00Z'),
        pr({ number: 11, mergedAt: '2026-10-09T00:00:00Z', body: '修 #10' }),
        pr({ number: 12, mergedAt: '2026-09-30T00:00:00Z', body: '修 #10' }),
        pr({ number: 13, mergedAt: '2026-10-03T00:00:00Z', body: '修 #100' }),
      ],
      runs: { 'local/10-x': [{ conclusion: 'success', createdAt: '2026-09-30T00:00:00Z' }] },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.prs[0]?.repairs).toEqual([]);
    expect(s.prs[0]?.rework).toBe(false);
  });

  it('合并不满 7 天、还没人修：不算返工，标观察期未满', async () => {
    const { gh } = fakeGh({
      prs: [haikuPr(10, '2026-10-15T00:00:00Z')],
      runs: { 'local/10-x': [{ conclusion: 'success', createdAt: '2026-10-14T00:00:00Z' }] },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.prs[0]).toMatchObject({ rework: false, watching: true });
  });

  it('只认 Haiku 的 PR：Sonnet 的、没标的都不进样本；提交尾注那一路也认', async () => {
    const { gh } = fakeGh({
      prs: [
        pr({ number: 1, mergedAt: '2026-10-10T00:00:00Z', body: '**写码模型**：claude-sonnet-5-5' }),
        pr({ number: 2, mergedAt: '2026-10-10T00:00:00Z' }),
        pr({ number: 3, mergedAt: '2026-10-10T00:00:00Z' }),
      ],
      // squash 合并的提交全文里带着分支上各提交的尾注
      commits: { deadbee3: `加个东西 (#3)\n\n${HAIKU_TRAILER}`, deadbee1: `x (#1)\n\n${SONNET_TRAILER}` },
      runs: { 'local/3-x': [{ conclusion: 'success', createdAt: '2026-10-09T00:00:00Z' }] },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.prs.map((p) => p.number)).toEqual([3]);
    expect(s.notes).toEqual([]);
  });

  it('读不到主线提交的尾注：写「没查成」，正文那一路照认，不整份报废', async () => {
    const { gh } = fakeGh({
      prs: [haikuPr(10, '2026-10-10T00:00:00Z')],
      commitsFail: 'HTTP 403',
      runs: { 'local/10-x': [{ conclusion: 'success', createdAt: '2026-10-09T00:00:00Z' }] },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.problem).toBeUndefined();
    expect(s.prs.map((p) => p.number)).toEqual([10]);
    expect(s.notes.join('')).toMatch(/没查成.*403/);
  });

  it('只看近 30 天：搜索条件带日期；窗口之前合并的不进样本', async () => {
    const { gh, calls } = fakeGh({
      prs: [haikuPr(10, '2026-09-01T00:00:00Z'), haikuPr(11, '2026-10-10T00:00:00Z')],
      runs: { 'local/11-x': [{ conclusion: 'success', createdAt: '2026-10-09T00:00:00Z' }] },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.prs.map((p) => p.number)).toEqual([11]);
    expect(calls[0]?.join(' ')).toContain('merged:>=2026-09-16');
  });

  it('读不到第一次 CI：写「没查成」带原因，不当成绿、也不当成红，不进返工率分母', async () => {
    const { gh } = fakeGh({
      prs: [haikuPr(10, '2026-10-01T00:00:00Z'), haikuPr(11, '2026-10-01T00:00:00Z')],
      runs: { 'local/10-x': ['ERR'] }, // 11 没有任何运行记录
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.prs[0]?.ci).toMatchObject({ state: 'unknown' });
    const ci = s.prs[0]?.ci;
    expect(ci?.state === 'unknown' ? ci.why : '').toMatch(/502/);
    expect(s.prs[1]?.ci).toMatchObject({ state: 'unknown' });
    expect(s.sample).toBe(0);
    expect(s.unknown).toBe(2);
    expect(s.rate).toBeNull();
  });

  it('CI 没查成、但已经有人修过：返工是确凿的，照算', async () => {
    const { gh } = fakeGh({
      prs: [
        haikuPr(10, '2026-10-01T00:00:00Z'),
        pr({ number: 11, mergedAt: '2026-10-02T00:00:00Z', body: '修 #10' }),
      ],
      runs: { 'local/10-x': ['ERR'] },
    });
    const s = await collectStats({ gh, now: NOW });
    expect(s.sample).toBe(1);
    expect(s.reworked).toBe(1);
  });

  it('PR 列表读不到：整份没查成，带原因，不给假数字', async () => {
    const { gh } = fakeGh({ prs: [], listFails: 'HTTP 401' });
    const s = await collectStats({ gh, now: NOW });
    expect(s.problem).toMatch(/401/);
    expect(s.prs).toEqual([]);
  });

  it('PR 列表的回包不是 JSON：没查成', async () => {
    const gh: Gh = () => ok('不是 JSON');
    const s = await collectStats({ gh, now: NOW });
    expect(s.problem).toBeDefined();
  });

  it('返工率 = 返工 ÷ 查成了的样本', async () => {
    const prs = [1, 2, 3, 4, 5].map((n) => haikuPr(n, '2026-10-02T00:00:00Z'));
    const runs: World['runs'] = {};
    for (const n of [1, 2, 3, 4, 5])
      runs[`local/${n}-x`] = [
        { conclusion: n === 1 ? 'failure' : 'success', createdAt: '2026-10-01T00:00:00Z' },
      ];
    const { gh } = fakeGh({ prs, runs });
    const s = await collectStats({ gh, now: NOW });
    expect(s.sample).toBe(5);
    expect(s.reworked).toBe(1);
    expect(s.rate).toBeCloseTo(0.2);
  });
});

describe('pnpm subagent:stats / --enforce', () => {
  const run = async (argv: string[], w: World, h = home()) => {
    const { gh } = fakeGh(w);
    const out: string[] = [];
    const err: string[] = [];
    const code = await subagentStats(argv, {
      gh,
      now: () => NOW,
      home: h,
      policy,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n'), home: h };
  };
  const greenRuns = (ns: number[]) =>
    Object.fromEntries(
      ns.map((n) => [`local/${n}-x`, [{ conclusion: 'success', createdAt: '2026-10-01T00:00:00Z' }]]),
    );

  it('不带 --enforce：只打报告，不写策略文件', async () => {
    const r = await run([], {
      prs: [haikuPr(10, '2026-10-10T00:00:00Z')],
      runs: { 'local/10-x': [{ conclusion: 'failure', createdAt: '2026-10-09T00:00:00Z' }] },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/#10/);
    expect(r.out).toMatch(/红/);
    expect(existsSync(policy.policyPath(r.home))).toBe(false);
  });

  it('报告里「没查成」照写，不写成 0', async () => {
    const r = await run([], { prs: [haikuPr(10, '2026-10-10T00:00:00Z')], runs: { 'local/10-x': ['ERR'] } });
    expect(r.out).toMatch(/没查成/);
    expect(r.out).not.toMatch(/返工率：0/);
  });

  it('--enforce：返工率超过 20% 且样本不少于 5：写收回，附原因和时刻', async () => {
    const ns = [1, 2, 3, 4, 5];
    const runs = greenRuns(ns);
    runs['local/1-x'] = [{ conclusion: 'failure', createdAt: '2026-10-01T00:00:00Z' }];
    runs['local/2-x'] = [{ conclusion: 'failure', createdAt: '2026-10-01T00:00:00Z' }];
    const r = await run(['--enforce'], { prs: ns.map((n) => haikuPr(n, '2026-10-12T00:00:00Z')), runs });
    expect(r.code).toBe(0);
    const p = policy.readPolicy(r.home);
    expect(p).toMatchObject({ revoked: true, at: '2026-10-16T12:00:00.000Z' });
    expect((p as { reason: string }).reason).toMatch(/返工率/);
    expect((p as { reason: string }).reason).toMatch(/2\/5/);
    expect(r.out).toMatch(/收回/);
  });

  it('--enforce：刚好 20%（1/5）不触发', async () => {
    const ns = [1, 2, 3, 4, 5];
    const runs = greenRuns(ns);
    runs['local/1-x'] = [{ conclusion: 'failure', createdAt: '2026-10-01T00:00:00Z' }];
    const r = await run(['--enforce'], { prs: ns.map((n) => haikuPr(n, '2026-10-12T00:00:00Z')), runs });
    expect(policy.readPolicy(r.home)).toEqual({ revoked: false });
    expect(r.out).toMatch(/没触发/);
  });

  it('--enforce：样本不到 5，返工率再高也不触发', async () => {
    const ns = [1, 2, 3, 4];
    const runs = Object.fromEntries(
      ns.map((n) => [`local/${n}-x`, [{ conclusion: 'failure', createdAt: '2026-10-01T00:00:00Z' }]]),
    );
    const r = await run(['--enforce'], { prs: ns.map((n) => haikuPr(n, '2026-10-12T00:00:00Z')), runs });
    expect(policy.readPolicy(r.home)).toEqual({ revoked: false });
  });

  it('--enforce：有一次错进 PR（合并后被修）就触发，样本再小也收回', async () => {
    const r = await run(['--enforce'], {
      prs: [
        haikuPr(10, '2026-10-01T00:00:00Z'),
        pr({ number: 11, mergedAt: '2026-10-03T00:00:00Z', body: '修 #10' }),
      ],
      runs: greenRuns([10]),
    });
    const p = policy.readPolicy(r.home);
    expect(p).toMatchObject({ revoked: true });
    expect((p as { reason: string }).reason).toMatch(/错进/);
    expect((p as { reason: string }).reason).toMatch(/#10/);
  });

  it('--enforce：已经收回了就不再覆盖，报告说「已收回」', async () => {
    const h = home();
    policy.revokePolicy(h, { reason: '第一次的原因', at: '2026-10-01T00:00:00.000Z' });
    const r = await run(
      ['--enforce'],
      {
        prs: [
          haikuPr(10, '2026-10-01T00:00:00Z'),
          pr({ number: 11, mergedAt: '2026-10-03T00:00:00Z', body: '修 #10' }),
        ],
        runs: greenRuns([10]),
      },
      h,
    );
    expect(policy.readPolicy(h)).toMatchObject({ reason: '第一次的原因' });
    expect(r.out).toMatch(/已收回/);
  });

  it('--enforce：数据没查成就不收回、也不放宽，退出码 2 并写明', async () => {
    const r = await run(['--enforce'], { prs: [], listFails: 'HTTP 502' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/502/);
    expect(policy.readPolicy(r.home)).toEqual({ revoked: false });
  });

  it('--lift：恢复后，恢复之前合并的 PR 不再触发同一条收回', async () => {
    const h = home();
    policy.revokePolicy(h, { reason: 'x', at: '2026-10-05T00:00:00.000Z' });
    const lift = await run(['--lift'], { prs: [] }, h);
    expect(lift.code).toBe(0);
    expect(policy.readPolicy(h)).toMatchObject({ revoked: false, liftedAt: '2026-10-16T12:00:00.000Z' });
    const again = await run(
      ['--enforce'],
      {
        prs: [
          haikuPr(10, '2026-10-01T00:00:00Z'),
          pr({ number: 11, mergedAt: '2026-10-03T00:00:00Z', body: '修 #10' }),
        ],
        runs: greenRuns([10]),
      },
      h,
    );
    expect(policy.readPolicy(h)).toMatchObject({ revoked: false });
    expect(again.out).toMatch(/没触发|没有/);
  });

  it('不认识的参数：退出码 1，用法', async () => {
    const r = await run(['--bogus'], { prs: [] });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/用法|subagent:stats/);
  });

  it('策略文件写进的是 JSON（hook 读的就是它）', async () => {
    const r = await run(['--enforce'], {
      prs: [
        haikuPr(10, '2026-10-01T00:00:00Z'),
        pr({ number: 11, mergedAt: '2026-10-03T00:00:00Z', body: '修 #10' }),
      ],
      runs: greenRuns([10]),
    });
    expect(JSON.parse(readFileSync(policy.policyPath(r.home), 'utf8'))).toMatchObject({ revoked: true });
  });
});
