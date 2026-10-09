// 主线 ci.yml 变红往飞书推一次（#766）：failure 判红、success 判绿，cancelled 和进行中的不改变上一次结论。
// 同一个提交只推一次；转绿推「已恢复」。没配、推不出去、运行列表读不到：没查成，不记已推。

import type { ScheduleResult } from '@fleet-dao/db';
import type { GhRequest, GhResponse } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { type HourlyReconcileJobDeps, runHourlyReconcileJob } from '../src/jobs/hourly-reconcile.ts';
import {
  judgeMainCi,
  type MainCiVerdict,
  type MainPushRun,
  pushMainRed,
  storedMainCiVerdict,
  verdictFromAlerts,
  verdictFromBody,
} from '../src/jobs/main-red-push.ts';
import type { SweepPart } from '../src/jobs/reconcile-common.ts';
import { FEISHU_WEBHOOK_ENV, feishuWebhookSender } from '../src/real/feishu-webhook.ts';
import { MAIN_CI_RUNS_PAGE, mainCiRuns } from '../src/real/main-ci-runs.ts';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const URL = 'https://github.com/thoerwink8/fleet-dao/actions/runs/99';
const URL2 = 'https://github.com/thoerwink8/fleet-dao/actions/runs/100';
const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-hook-token-for-logs';
const NOW = new Date('2026-10-10T01:41:00.000Z');

const run = (over: Partial<MainPushRun> = {}): MainPushRun => ({
  status: 'completed',
  conclusion: 'failure',
  sha: SHA,
  url: URL,
  failedJobs: ['test (engine)', 'lint'],
  ...over,
});

function world() {
  const sent: string[] = [];
  const marked: { key: string; body: string }[] = [];
  const byKey = new Map<string, string>();
  let verdict: MainCiVerdict | null = null;
  let rememberFault: Error | null = null;
  const push = (
    runs: readonly MainPushRun[] | (() => Promise<readonly MainPushRun[]>),
    send: (text: string) => Promise<void> = async (text) => {
      sent.push(text);
    },
  ) =>
    pushMainRed({
      listPushRuns: typeof runs === 'function' ? runs : async () => runs,
      previousVerdict: async () => verdict,
      sentBody: async (key) => byKey.get(key) ?? null,
      markSent: async (x) => {
        // 推送键再写一次不改结论：提醒表原地更新不挪 createdAt，上一次结论只听结论行。
        marked.push({ key: x.dedupeKey, body: x.body });
        byKey.set(x.dedupeKey, x.body);
      },
      rememberVerdict: async (x) => {
        if (rememberFault) {
          const err = rememberFault;
          rememberFault = null;
          throw err;
        }
        verdict = x.verdict;
      },
      send,
    });
  return {
    sent,
    marked,
    push,
    breakRemember() {
      rememberFault = new Error('结论写不进');
    },
  };
}

describe('judgeMainCi：最近一次已结束的 push 运行', () => {
  const rows: {
    status: string;
    conclusion: string | null;
    previous: MainCiVerdict | null;
    expect: MainCiVerdict | null;
  }[] = [
    { status: 'completed', conclusion: 'failure', previous: null, expect: 'red' },
    { status: 'completed', conclusion: 'failure', previous: 'green', expect: 'red' },
    { status: 'completed', conclusion: 'failure', previous: 'red', expect: 'red' },
    { status: 'completed', conclusion: 'success', previous: null, expect: 'green' },
    { status: 'completed', conclusion: 'success', previous: 'red', expect: 'green' },
    { status: 'completed', conclusion: 'success', previous: 'green', expect: 'green' },
    { status: 'completed', conclusion: 'cancelled', previous: 'red', expect: 'red' },
    { status: 'completed', conclusion: 'cancelled', previous: 'green', expect: 'green' },
    { status: 'completed', conclusion: 'cancelled', previous: null, expect: null },
    { status: 'completed', conclusion: 'timed_out', previous: 'red', expect: 'red' },
    { status: 'completed', conclusion: 'skipped', previous: 'green', expect: 'green' },
    { status: 'in_progress', conclusion: null, previous: 'red', expect: 'red' },
    { status: 'queued', conclusion: null, previous: 'green', expect: 'green' },
    { status: 'in_progress', conclusion: 'failure', previous: null, expect: null },
    { status: 'waiting', conclusion: null, previous: 'red', expect: 'red' },
  ];

  it.each(rows)('$status / $conclusion / 上次 $previous → $expect', (row) => {
    expect(judgeMainCi({ status: row.status, conclusion: row.conclusion }, row.previous)).toBe(row.expect);
  });

  it('没有运行：不改变上一次结论', () => {
    expect(judgeMainCi(null, 'red')).toBe('red');
    expect(judgeMainCi(null, null)).toBeNull();
  });
});

describe('verdictFromAlerts', () => {
  const at = (iso: string, id: string) => ({ createdAt: new Date(iso), id });

  it('没有记下过是 null；只有红是红；只有已恢复是绿；同一时刻 id 大的算新', () => {
    expect(verdictFromAlerts(null, null)).toBeNull();
    expect(verdictFromAlerts(at('2026-10-10T00:00:00Z', '1'), null)).toBe('red');
    expect(verdictFromAlerts(null, at('2026-10-10T00:00:00Z', '1'))).toBe('green');
    expect(verdictFromAlerts(at('2026-10-10T01:00:00Z', 'a'), at('2026-10-10T00:00:00Z', 'b'))).toBe('red');
    expect(verdictFromAlerts(at('2026-10-10T00:00:00Z', 'a'), at('2026-10-10T01:00:00Z', 'b'))).toBe('green');
    expect(verdictFromAlerts(at('2026-10-10T00:00:00Z', 'b'), at('2026-10-10T00:00:00Z', 'a'))).toBe('red');
  });
});

describe('结论行压过推送键的建立时刻', () => {
  const red = { createdAt: new Date('2026-10-10T00:00:00Z'), id: 'a' };
  const recovered = { createdAt: new Date('2026-10-10T01:00:00Z'), id: 'b' };

  it('正文是 red / green 就听它；过期撤掉前面加了「已撤」也认最后一行', () => {
    expect(verdictFromBody(null)).toBeNull();
    expect(verdictFromBody('')).toBeNull();
    expect(verdictFromBody('red')).toBe('red');
    expect(verdictFromBody('green')).toBe('green');
    expect(verdictFromBody('已撤：过期\n\nred')).toBe('red');
    expect(verdictFromBody('认不出')).toBeNull();
  });

  it('结论行说红，不再听更晚的已恢复键；没有结论行才退回去', () => {
    expect(storedMainCiVerdict('red', red, recovered)).toBe('red');
    expect(storedMainCiVerdict('已撤：过期\n\ngreen', red, null)).toBe('green');
    expect(storedMainCiVerdict(null, red, recovered)).toBe('green');
    expect(storedMainCiVerdict('认不出', red, recovered)).toBe('green');
  });
});

describe('pushMainRed', () => {
  it('变红推一条：正文含提交号前 7 位、运行链接、失败的作业名', async () => {
    const w = world();
    const part = await w.push([run()]);
    expect(part).toMatchObject({ found: 1, unchecked: [] });
    expect(w.sent).toHaveLength(1);
    const text = w.sent[0] ?? '';
    expect(text).toContain(SHA.slice(0, 7));
    expect(text).not.toContain(SHA);
    expect(text).toContain(URL);
    expect(text).toContain('test (engine)');
    expect(text).toContain('lint');
    expect(w.marked.map((m) => m.key)).toEqual([`feishu:main-red:${SHA}`]);
    expect(w.marked[0]?.body).toBe(text);
  });

  it('同一个提交再次变红不再推，结论仍改成红，之后别的提交转绿推已恢复', async () => {
    const w = world();
    const urlAgain = 'https://github.com/thoerwink8/fleet-dao/actions/runs/101';
    const urlB = 'https://github.com/thoerwink8/fleet-dao/actions/runs/102';
    await w.push([run()]);
    await w.push([run({ conclusion: 'success', failedJobs: [] })]);
    const again = await w.push([run({ url: urlAgain })]);
    expect(again).toMatchObject({ found: 0, unchecked: [] });
    expect(w.sent).toHaveLength(2);
    expect(w.marked.filter((m) => m.key === `feishu:main-red:${SHA}`)).toHaveLength(1);

    const recovered = await w.push([run({ conclusion: 'success', sha: SHA2, url: urlB, failedJobs: [] })]);
    expect(recovered).toMatchObject({ found: 1, unchecked: [] });
    expect(w.sent).toHaveLength(3);
    const text = w.sent[2] ?? '';
    expect(text).toContain('已恢复');
    expect(text).toContain(SHA2.slice(0, 7));
    expect(text).toContain(urlB);
    expect(w.marked.filter((m) => m.key === `feishu:main-recovered:${SHA2}`)).toHaveLength(1);
  });

  it('同一个提交再次转绿不再推，结论改回绿，之后别的提交仍是绿的不推已恢复', async () => {
    const w = world();
    await w.push([run()]);
    await w.push([run({ conclusion: 'success', failedJobs: [] })]);
    await w.push([run({ url: 'https://github.com/thoerwink8/fleet-dao/actions/runs/101' })]);
    const secondGreen = await w.push([
      run({
        conclusion: 'success',
        url: 'https://github.com/thoerwink8/fleet-dao/actions/runs/103',
        failedJobs: [],
      }),
    ]);
    expect(secondGreen).toMatchObject({ found: 0, unchecked: [] });
    expect(w.sent).toHaveLength(2);
    expect(w.marked.filter((m) => m.key === `feishu:main-recovered:${SHA}`)).toHaveLength(1);

    const later = await w.push([run({ conclusion: 'success', sha: SHA2, url: URL2, failedJobs: [] })]);
    expect(later).toMatchObject({ found: 0, unchecked: [] });
    expect(w.sent).toHaveLength(2);
  });

  it('再次变红时结论记不下来：没查成，下一轮记下之后别的提交转绿仍推已恢复', async () => {
    const w = world();
    await w.push([run()]);
    await w.push([run({ conclusion: 'success', failedJobs: [] })]);
    w.breakRemember();
    const again = await w.push([run({ url: 'https://github.com/thoerwink8/fleet-dao/actions/runs/101' })]);
    expect(again.found).toBe(0);
    expect(again.unchecked.join('\n')).toContain('没查成');
    expect(w.sent).toHaveLength(2);
    expect(w.marked.filter((m) => m.key === `feishu:main-red:${SHA}`)).toHaveLength(1);

    const retried = await w.push([run({ url: 'https://github.com/thoerwink8/fleet-dao/actions/runs/101' })]);
    expect(retried).toMatchObject({ found: 0, unchecked: [] });
    const recovered = await w.push([run({ conclusion: 'success', sha: SHA2, url: URL2, failedJobs: [] })]);
    expect(recovered).toMatchObject({ found: 1, unchecked: [] });
    expect(w.sent[2]).toContain('已恢复');
  });

  it('同一个提交第二轮不再推', async () => {
    const w = world();
    await w.push([run()]);
    const again = await w.push([run()]);
    expect(again).toMatchObject({ found: 0, unchecked: [] });
    expect(w.sent).toHaveLength(1);
    expect(w.marked).toHaveLength(1);
  });

  it('转绿推已恢复；本来就是绿的不推', async () => {
    const w = world();
    await w.push([run()]);
    const green = await w.push([run({ conclusion: 'success', sha: SHA2, url: URL2, failedJobs: [] })]);
    expect(green).toMatchObject({ found: 1, unchecked: [] });
    const text = w.sent[1] ?? '';
    expect(text).toContain('已恢复');
    expect(text).toContain(SHA2.slice(0, 7));
    expect(text).toContain(URL2);
    expect(w.marked[1]?.key).toBe(`feishu:main-recovered:${SHA2}`);

    const still = await w.push([run({ conclusion: 'success', sha: SHA2, url: URL2, failedJobs: [] })]);
    expect(still.found).toBe(0);
    expect(w.sent).toHaveLength(2);

    const healthy = world();
    const first = await healthy.push([run({ conclusion: 'success', sha: SHA, url: URL, failedJobs: [] })]);
    expect(first).toMatchObject({ found: 0, unchecked: [] });
    expect(healthy.sent).toEqual([]);
  });

  it('cancelled、进行中不改变上一次结论：不推', async () => {
    const w = world();
    await w.push([run()]);
    const cancelled = await w.push([run({ conclusion: 'cancelled', sha: SHA2, url: URL2, failedJobs: [] })]);
    expect(cancelled.found).toBe(0);
    expect(w.sent).toHaveLength(1);

    const busy = await w.push([
      run({ status: 'in_progress', conclusion: null, sha: SHA2, url: URL2, failedJobs: [] }),
      run(),
    ]);
    expect(busy.found).toBe(0);
    expect(w.sent).toHaveLength(1);
  });

  it('新的红提交再推一次；进行中的后面那次已结束的成功，从红转绿', async () => {
    const w = world();
    await w.push([run()]);
    const next = await w.push([run({ sha: SHA2, url: URL2, failedJobs: ['typecheck'] })]);
    expect(next.found).toBe(1);
    expect(w.sent[1]).toContain('typecheck');
    expect(w.marked[1]?.key).toBe(`feishu:main-red:${SHA2}`);

    const recovered = await w.push([
      run({ status: 'in_progress', conclusion: null, sha: 'c'.repeat(40), failedJobs: [] }),
      run({ conclusion: 'success', sha: SHA, url: URL, failedJobs: [] }),
    ]);
    expect(recovered.found).toBe(1);
    expect(w.sent[2]).toContain('已恢复');
    expect(w.marked[2]?.key).toBe(`feishu:main-recovered:${SHA}`);
  });

  it('读运行列表失败记没查成，不记已推', async () => {
    const w = world();
    const part = await w.push(async () => {
      throw new Error('ci.yml 运行列表认不出（没有 workflow_runs）');
    });
    expect(part.found).toBe(0);
    expect(part.unchecked.join('\n')).toContain('没查成');
    expect(w.marked).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it('没配、code 非 0：没查成，不记已推，下一轮还能再推', async () => {
    const missing = world();
    const unconfigured = feishuWebhookSender({
      env: {},
      fetchImpl: async () => {
        throw new Error('不该请求');
      },
      sleep: async () => {},
    });
    const part = await missing.push([run()], unconfigured);
    expect(part.found).toBe(0);
    expect(part.unchecked.join('\n')).toContain('没查成');
    expect(part.unchecked.join('\n')).toContain('没配');
    expect(missing.marked).toEqual([]);

    let codes = 0;
    const nonzero = feishuWebhookSender({
      env: { [FEISHU_WEBHOOK_ENV]: HOOK },
      fetchImpl: async () => {
        codes += 1;
        return new Response(JSON.stringify({ code: 19021 }), { status: 200 });
      },
      sleep: async () => {},
    });
    const bad = await missing.push([run()], nonzero);
    expect(codes).toBe(3);
    expect(bad.found).toBe(0);
    expect(bad.unchecked.join('\n')).toContain('没查成');
    expect(missing.marked).toEqual([]);

    const retried = await missing.push([run()]);
    expect(retried.found).toBe(1);
    expect(missing.sent).toHaveLength(1);
  });
});

/** 一条主线 push 运行。id 从 1 起，提交号按序号铺成 40 位十六进制。 */
function listedRun(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: i,
    status: 'in_progress',
    conclusion: null,
    head_sha: i.toString(16).padStart(40, '0'),
    head_branch: 'main',
    event: 'push',
    html_url: `https://github.com/thoerwink8/fleet-dao/actions/runs/${i}`,
    ...over,
  };
}

/** 更新的一页全是进行中，已结束的在后面。GitHub 不认 status 时就按这个原样分页。 */
function inProgressPage(): Record<string, unknown>[] {
  return Array.from({ length: MAIN_CI_RUNS_PAGE }, (_, i) => listedRun(1000 + i));
}

function runsClient(opts: { pages: Record<string, unknown>[][]; failPage?: number }): {
  calls: { path: string; query?: unknown }[];
  client: Parameters<typeof mainCiRuns>[0]['client'];
} {
  const calls: { path: string; query?: unknown }[] = [];
  return {
    calls,
    client: {
      async request<T = unknown>(req: GhRequest): Promise<GhResponse<T>> {
        calls.push({ path: req.path, query: req.query });
        const page = Number(req.query?.page ?? 1);
        if (opts.failPage !== undefined && page === opts.failPage) throw new Error('这一页连不上');
        return {
          status: 200,
          data: { workflow_runs: opts.pages[page - 1] ?? [] } as T,
          headers: new Headers(),
        };
      },
      async all<T = unknown>(req: GhRequest, itemsOf?: (data: unknown) => unknown): Promise<T[]> {
        calls.push({ path: req.path, query: req.query });
        const data = {
          jobs: [
            { id: 1, name: 'lint', conclusion: 'success' },
            { id: 2, name: 'test (engine)', conclusion: 'failure' },
          ],
        };
        const items = (itemsOf ?? ((d: unknown) => d))(data);
        if (!Array.isArray(items)) throw new Error('not array');
        return items as T[];
      },
    },
  };
}

describe('mainCiRuns', () => {
  it('只认主线 push；失败的运行带上结论为 failure 的作业名', async () => {
    const calls: { path: string; query?: unknown }[] = [];
    const list = mainCiRuns({
      client: {
        async request<T = unknown>(req: GhRequest): Promise<GhResponse<T>> {
          calls.push({ path: req.path, query: req.query });
          return {
            status: 200,
            data: {
              workflow_runs: [
                {
                  id: 100,
                  status: 'in_progress',
                  conclusion: null,
                  head_sha: SHA2,
                  head_branch: 'main',
                  event: 'push',
                  html_url: URL2,
                },
                {
                  id: 99,
                  status: 'completed',
                  conclusion: 'failure',
                  head_sha: SHA,
                  head_branch: 'main',
                  event: 'push',
                  html_url: URL,
                },
              ],
            } as T,
            headers: new Headers(),
          };
        },
        async all<T = unknown>(req: GhRequest, itemsOf?: (data: unknown) => unknown): Promise<T[]> {
          calls.push({ path: req.path });
          const data = {
            jobs: [
              { id: 1, name: 'lint', conclusion: 'success' },
              { id: 2, name: 'test (engine)', conclusion: 'failure' },
              { id: 3, name: 'test (api)', conclusion: 'cancelled' },
            ],
          };
          const items = (itemsOf ?? ((d: unknown) => d))(data);
          if (!Array.isArray(items)) throw new Error('not array');
          return items as T[];
        },
      },
    });
    const runs = await list();
    expect(runs[0]).toMatchObject({ status: 'in_progress', conclusion: null, sha: SHA2, failedJobs: [] });
    expect(runs[1]).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
      sha: SHA,
      url: URL,
      failedJobs: ['test (engine)'],
    });
    expect(calls[0]?.path).toContain('/actions/workflows/ci.yml/runs');
    expect(calls[0]?.query).toMatchObject({ branch: 'main', event: 'push' });
    expect(calls.some((c) => c.path.includes('/actions/runs/99/jobs'))).toBe(true);
    expect(calls.some((c) => c.path.includes('/actions/runs/100/jobs'))).toBe(false);
  });

  it('【故意造出的失败】运行列表认不出：没查成，不当成没有运行', async () => {
    const list = mainCiRuns({
      client: {
        async request<T = unknown>(): Promise<GhResponse<T>> {
          return { status: 200, data: { total_count: 0 } as T, headers: new Headers() };
        },
        async all(): Promise<never[]> {
          throw new Error('不该列作业');
        },
      },
    });
    await expect(list()).rejects.toThrow(/没查成/);
  });

  it('最近一页全是进行中：翻到下一页的已结束失败，带上失败作业名', async () => {
    const api = runsClient({
      pages: [
        inProgressPage(),
        [listedRun(99, { status: 'completed', conclusion: 'failure', head_sha: SHA, html_url: URL })],
      ],
    });
    const runs = await mainCiRuns(api)();
    expect(runs.find((r) => r.status === 'completed')).toMatchObject({
      conclusion: 'failure',
      sha: SHA,
      url: URL,
      failedJobs: ['test (engine)'],
    });
    const listed = api.calls.filter((c) => c.path.includes('/workflows/ci.yml/runs'));
    expect(listed.map((c) => (c.query as { page?: number }).page)).toEqual([1, 2]);
    expect(listed[0]?.query).toMatchObject({ branch: 'main', event: 'push', status: 'completed' });
    expect(api.calls.some((c) => c.path.includes('/actions/runs/99/jobs'))).toBe(true);
    expect(api.calls.some((c) => c.path.includes('/actions/runs/1000/jobs'))).toBe(false);
  });

  it('翻到上限仍全是进行中：没查成，不当成没有已结束的运行', async () => {
    let n = 0;
    const list = mainCiRuns({
      client: {
        async request<T = unknown>(): Promise<GhResponse<T>> {
          n += 1;
          if (n > 20) throw new Error('翻太多了');
          return { status: 200, data: { workflow_runs: inProgressPage() } as T, headers: new Headers() };
        },
        async all(): Promise<never[]> {
          throw new Error('不该列作业');
        },
      },
    });
    await expect(list()).rejects.toThrow(/没查成/);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(20);
  });
});

describe('进行中占满一页时仍要推', () => {
  it('下一页才是失败：变红推一次，不空过', async () => {
    const api = runsClient({
      pages: [
        inProgressPage(),
        [listedRun(99, { status: 'completed', conclusion: 'failure', head_sha: SHA, html_url: URL })],
      ],
    });
    const w = world();
    const part = await w.push(mainCiRuns(api));
    expect(part).toMatchObject({ found: 1, unchecked: [] });
    const text = w.sent[0] ?? '';
    expect(text).toContain(SHA.slice(0, 7));
    expect(text).toContain(URL);
    expect(text).toContain('test (engine)');
    expect(w.marked.map((m) => m.key)).toEqual([`feishu:main-red:${SHA}`]);
  });

  it('下一页才是成功：上一次是红就推已恢复', async () => {
    const api = runsClient({
      pages: [
        inProgressPage(),
        [listedRun(100, { status: 'completed', conclusion: 'success', head_sha: SHA2, html_url: URL2 })],
      ],
    });
    const w = world();
    await w.push([run()]);
    const part = await w.push(mainCiRuns(api));
    expect(part).toMatchObject({ found: 1, unchecked: [] });
    const text = w.sent[1] ?? '';
    expect(text).toContain('已恢复');
    expect(text).toContain(SHA2.slice(0, 7));
    expect(text).toContain(URL2);
    expect(w.marked[1]?.key).toBe(`feishu:main-recovered:${SHA2}`);
  });

  it('翻页读不到：记没查成，不记已推', async () => {
    const api = runsClient({ pages: [inProgressPage()], failPage: 2 });
    const w = world();
    const part = await w.push(mainCiRuns(api));
    expect(part.found).toBe(0);
    expect(part.unchecked.join('\n')).toContain('没查成');
    expect(w.sent).toEqual([]);
    expect(w.marked).toEqual([]);
  });

  it('翻完了确实没有已结束的：不推，也不记没查成', async () => {
    const api = runsClient({ pages: [inProgressPage()] });
    const w = world();
    const part = await w.push(mainCiRuns(api));
    expect(part).toMatchObject({ found: 0, unchecked: [] });
    expect(w.sent).toEqual([]);
    expect(w.marked).toEqual([]);
    expect(api.calls.filter((c) => c.path.includes('/workflows/ci.yml/runs'))).toHaveLength(2);
  });
});

/** 外壳只要能跑一轮：主线红这一项由用例注入。 */
function reconcileHarness(mainRedPush: () => Promise<SweepPart>): {
  deps: HourlyReconcileJobDeps;
  finished: { id: number; result: ScheduleResult }[];
} {
  const finished: { id: number; result: ScheduleResult }[] = [];
  const deps: HourlyReconcileJobDeps = {
    root: '/var/lib/fleet-work',
    probeDir: '_route-probe',
    sessionTmpDir: '_tmp',
    machine: '法国',
    async listDir(dir) {
      if (dir === '/var/lib/fleet-work') return [{ name: '_route-probe', isDir: true }];
      if (dir === '/var/lib/fleet-work/_route-probe') return [{ name: 'fleet-agent-carpool', isDir: true }];
      throw new Error(`用例没给 ${dir}`);
    },
    treeFor: (repo, branch) => `/var/lib/fleet-work/${repo.owner}_${repo.name}/${branch}`,
    ownerOf: async () => null,
    leftovers: async () => ({ kind: 'empty' }),
    remove: async () => ({ gone: true }),
    issue: async () => null,
    prHeads: async () => [],
    subtaskTrees: async () => [],
    openSessions: async () => [],
    workflows: {
      state: async () => ({ state: 'missing' }),
      view: async () => {
        throw new Error('不该问');
      },
    },
    taskState: async () => null,
    approval: async () => null,
    stageRoutable: async () => ({ kind: 'none', detail: '没有在线的路由' }),
    alerts: {
      listOpen: async () => ({ alerts: [], truncated: false }),
      byKey: async () => null,
      latestByPrefix: async () => null,
      resolve: async () => 'not_found',
      raise: async () => {},
      insertOnce: async () => ({ created: true }),
      updateOpen: async () => 'not_open',
    },
    repos: async () => [],
    auditMergedPrs: async () => ({
      outcome: 'ok',
      scanned: 0,
      found: 0,
      fixed: 0,
      problems: [],
      findings: [],
    }),
    quotaPools: async () => [],
    ledgers: async () => [],
    apps: { repos: async () => [], selfCheck: async () => [] },
    gh: {
      listPrs: async () => [],
      pullFiles: async () => [],
      checksEvaluate: async () => 'none',
      requiredChecks: async () => ['check'],
      readStandardPathsFile: async () => '{"paths":[]}',
      enableAutoMerge: async () => {},
    },
    autoMergeAlerts: {
      raise: async () => {},
      resolve: async () => 'not_found',
      listOpenByPrefix: async () => [],
    },
    closedIssueTasks: {
      runningTaskWorkflowIds: async () => [],
      issueState: async () => 'open',
      abandon: async () => 'gone',
    },
    runs: {
      async start() {
        return 7;
      },
      async finish(id, result) {
        finished.push({ id, result });
      },
    },
    now: () => NOW,
    log: () => {},
    mainRedPush,
  };
  return { deps, finished };
}

describe('对账里的主线红', () => {
  it('【故意造出的失败】webhook 回 5xx 三次：发了 3 次、没记已推、对账结果里有没查成', async () => {
    let n = 0;
    const marked: string[] = [];
    let remembered = 0;
    const send = feishuWebhookSender({
      env: { [FEISHU_WEBHOOK_ENV]: HOOK },
      fetchImpl: async () => {
        n += 1;
        return new Response('upstream down', { status: 500 });
      },
      sleep: async () => {},
    });
    const h = reconcileHarness(() =>
      pushMainRed({
        listPushRuns: async () => [run()],
        previousVerdict: async () => null,
        sentBody: async () => null,
        markSent: async (x) => {
          marked.push(x.dedupeKey);
        },
        rememberVerdict: async () => {
          remembered += 1;
        },
        send,
      }),
    );
    const result = await runHourlyReconcileJob(h.deps);
    expect(n).toBe(3);
    expect(marked).toEqual([]);
    expect(remembered).toBe(0);
    expect(result.outcome).not.toBe('ok');
    expect(result.why).toContain('没查成');
    expect(h.finished[0]?.result.outcome).not.toBe('ok');
  });
});
