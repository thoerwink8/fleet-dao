import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ghApi } from '../src/gh-api.ts';
import {
  type GateDeps,
  type GateState,
  type GitHubReads,
  gateGitHub,
  gatePr,
  runMergeGate,
} from '../src/merge-gate.ts';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);

interface World {
  pr: Record<string, unknown>;
  statuses: unknown[];
  written: { sha: string; state: GateState; description: string; targetUrl?: string }[];
  /** 按方法名故意抛错。 */
  broken: Partial<Record<keyof GitHubReads, string>>;
  open: Record<string, unknown>[];
  /** 读了几次 PR 本身。 */
  prReads: number;
  /** 读了几次提交状态。 */
  statusReads: number;
}

function world(
  over: Partial<World> & { prOver?: Record<string, unknown> } = {},
): World & { gh: GitHubReads } {
  const w: World = {
    pr: {
      number: 80,
      title: '试一下',
      head: { sha: HEAD, ref: 'feat/x' },
      state: 'open',
      ...over.prOver,
    },
    statuses: [],
    written: [],
    broken: {},
    open: [],
    prReads: 0,
    statusReads: 0,
    ...over,
  };
  const boom = (k: keyof GitHubReads) => {
    if (w.broken[k]) throw new Error(w.broken[k]);
  };
  const gh: GitHubReads = {
    async pr(n) {
      boom('pr');
      w.prReads += 1;
      return { ...w.pr, number: n };
    },
    async statuses() {
      boom('statuses');
      w.statusReads += 1;
      return w.statuses;
    },
    async openPrs() {
      boom('openPrs');
      return w.open;
    },
    async writeStatus(sha, s) {
      boom('writeStatus');
      w.written.push({ sha, ...s });
    },
  };
  return Object.assign(w, { gh });
}

const deps = (w: { gh: GitHubReads }): GateDeps => ({ gh: w.gh });

/** #555-2：引擎任务工作流开的 PR 还要有一条通过的冷调用结论（另一个 context，闸只读）。 */
const CV_OK = [{ context: 'cold-verify', state: 'success', description: '验收通过' }];

describe('合并闸：验收场景', () => {
  it('① 人手开的 PR → 通过，只看 CI：不读提交状态', async () => {
    const w = world();
    const r = await gatePr(80, deps(w));
    expect(r).toMatchObject({ number: 80, head: HEAD, state: 'success', notChecked: false });
    expect(r.lines).toEqual(['能合：不是引擎任务 PR，只看 CI。']);
    expect(w.statusReads).toBe(0);
  });

  it('② 草稿、和主线冲突、没标签、没里程碑、正文随便写：闸一概不看（#654，草稿和冲突 GitHub 自己合不了），PR 只读一次', async () => {
    const w = world({
      prOver: {
        draft: true,
        mergeable: false,
        merge_commit_sha: null,
        labels: [],
        milestone: null,
        body: '改了一行',
      },
    });
    const r = await gatePr(80, deps(w));
    expect(r).toMatchObject({ state: 'success', notChecked: false });
    // GitHub 还在算冲突（mergeable 是 null）也不再等：不轮询
    const unknown = world({ prOver: { mergeable: null } });
    expect((await gatePr(80, deps(unknown))).state).toBe('success');
    expect(unknown.prReads).toBe(1);
  });

  it('③ 【#1114 钉住】改到迁移（含 DROP）、ci.yml、鉴权、部署脚本的 PR：合并闸不再要第二意见——没有任何第二意见状态也放行，改了哪些文件闸压根不读', async () => {
    const w = world({
      prOver: {
        changed_files: 4,
        // 闸读不到、也不看这些：留在 PR 上只为说明场景
        files: [
          'packages/db/migrations/0042_drop_x.sql',
          '.github/workflows/ci.yml',
          'packages/api/src/auth.ts',
          'deploy/france.sh',
        ],
      },
      // 老的 second-opinion 状态就算是 failure / pending / 压根没有，也不影响结论
      statuses: [{ context: 'second-opinion', state: 'failure', description: '旧的状态' }],
    });
    const r = await gatePr(80, deps(w));
    expect(r.state).toBe('success');
    expect(r.notChecked).toBe(false);
    expect(r.lines.join('\n')).not.toContain('第二意见');
    expect(w.statusReads).toBe(0);
    // 读写的口子里没有「读文件」那几个：闸没法看改了哪些文件
    expect(Object.keys(w.gh).sort()).toEqual(['openPrs', 'pr', 'statuses', 'writeStatus']);
  });

  it('正文里怎么写都一样：闸按分支名认引擎的 PR，不看正文', async () => {
    for (const body of ['先审后合——改部署', '直接合——小改', '']) {
      expect((await gatePr(80, deps(world({ prOver: { body } })))).state, body).toBe('success');
    }
  });
});

describe('合并闸：#555-2 引擎任务工作流开的 PR，合前一次冷调用的结论（cold-verify）是输入', () => {
  /** 引擎任务工作流起的分支（fleet/<单号>-t<8 位>）。 */
  const FLOW = { head: { sha: HEAD, ref: 'fleet/12-t1a2b3c4d' } };
  const flowWorld = (over: Parameters<typeof world>[0] = {}) =>
    world({ ...over, prOver: { ...FLOW, ...over.prOver } });

  it('引擎的 PR、还没有冷调用结论 → 不通过，写明「还没验」和为什么要验', async () => {
    const r = await gatePr(80, deps(flowWorld()));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^还没验：当前头 aaaaaaa 上没有 cold-verify 状态/);
    expect(r.lines[0]).toContain('引擎任务工作流开的 PR');
  });

  it('引擎的 PR、冷调用通过 → 通过', async () => {
    const r = await gatePr(80, deps(flowWorld({ statuses: CV_OK })));
    expect(r.state).toBe('success');
    expect(r.lines[0]).toBe('能合：引擎任务 PR 的验收那一遍通过。');
  });

  it('冷调用 pending → 不通过（还在跑，等它）', async () => {
    const r = await gatePr(
      80,
      deps(
        flowWorld({ statuses: [{ context: 'cold-verify', state: 'pending', description: '第 1 轮跑着' }] }),
      ),
    );
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^等验收：.*还在跑/);
  });

  it('冷调用说没过 → 不通过，写明「验收没过」和轮数上限', async () => {
    const r = await gatePr(
      80,
      deps(
        flowWorld({
          statuses: [
            {
              context: 'cold-verify',
              state: 'failure',
              description: '验收没过（第 1 轮）：单子要 A、代码做了 B',
            },
          ],
        }),
      ),
    );
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^验收没过/);
    expect(r.lines[0]).toContain('最多 2 轮');
  });

  it('【故意造出的失败】冷调用写成 error（GitHub 半路把状态写成 error）也算没过，不算通过', async () => {
    const r = await gatePr(
      80,
      deps(flowWorld({ statuses: [{ context: 'cold-verify', state: 'error', description: '' }] })),
    );
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^验收没过：.* 是 error/);
  });

  it('【故意造出的失败】冷调用那条的 state 认不出 → 判「没查成」（不当成没问题）', async () => {
    const r = await gatePr(
      80,
      deps(flowWorld({ statuses: [{ context: 'cold-verify', state: 'whatever', description: '' }] })),
    );
    expect(r.state).toBe('failure');
    expect(r.notChecked).toBe(true);
    expect(r.lines[0]).toMatch(/^没查成：.*cold-verify 的 state「whatever」认不出/);
  });

  it('【故意造出的失败】读不到当前头的提交状态 → 判「没查成」，不许当成「验过了」', async () => {
    const r = await gatePr(80, deps(flowWorld({ broken: { statuses: '状态接口 502' } })));
    expect(r.state).toBe('failure');
    expect(r.notChecked).toBe(true);
    expect(r.lines.join('\n')).toContain('读不到当前头');
  });

  it('人手开的 PR（分支名不是引擎的）：压根不等这条状态，别的 PR 的冷调用结论也不影响它', async () => {
    const r = await gatePr(
      80,
      deps(
        world({
          statuses: [{ context: 'cold-verify', state: 'failure', description: '别的 PR 的结论' }],
        }),
      ),
    );
    expect(r.state).toBe('success');
  });

  it('像引擎分支又不是的名字（位数不对、前缀不对）：当人手开的 PR 看', async () => {
    for (const ref of [
      'fleet/12-t1a2b3c',
      'fleet/12-tXYZ12345',
      'feat/fleet/12-t1a2b3c4d',
      'fleet/x-t1a2b3c4d',
    ]) {
      const r = await gatePr(80, deps(world({ prOver: { head: { sha: HEAD, ref } } })));
      expect(r.state, ref).toBe('success');
    }
  });

  it('【故意造出的失败】PR 读回来没有分支名（head.ref）→ 判「没查成」：认不出是不是引擎的 PR，不能当成人手开的放行', async () => {
    const r = await gatePr(80, deps(world({ prOver: { head: { sha: HEAD } } })));
    expect(r.state).toBe('failure');
    expect(r.notChecked).toBe(true);
    expect(r.lines[0]).toMatch(/head.ref 认不出/);
  });
});

describe('合并闸：决定结论的读不到、认不出都是「没查成」，写 failure，不当通过', () => {
  const cases: [string, Parameters<typeof world>[0], RegExp][] = [
    [
      'PR 读不到',
      { broken: { pr: 'GitHub 回了 502' } },
      /^没查成：读不到 PR #80 现在的样子（GitHub 回了 502）/,
    ],
    ['PR 没有头', { prOver: { head: {} } }, /head\.sha 认不出/],
    ['PR 的 state 认不出', { prOver: { state: 'merged' } }, /state 认不出/],
    [
      '提交状态读不到',
      { prOver: { head: { sha: HEAD, ref: 'fleet/12-t1a2b3c4d' } }, broken: { statuses: '502' } },
      /读不到当前头 aaaaaaa 的提交状态（502）/,
    ],
    [
      '提交状态认不出',
      {
        prOver: { head: { sha: HEAD, ref: 'fleet/12-t1a2b3c4d' } },
        statuses: [{ context: 'cold-verify', state: '通过' }],
      },
      /提交状态认不出/,
    ],
  ];

  it.each(cases)('%s', async (_name, over, line) => {
    const r = await gatePr(80, deps(world(over)));
    expect(r.state).toBe('failure');
    expect(r.notChecked).toBe(true);
    expect(r.lines[0]).toMatch(/^没查成：/);
    expect(r.lines.join('\n')).toMatch(line);
  });

  it('PR 读回来没有号：没查成', async () => {
    const w = world();
    const gh = { ...w.gh, pr: async () => ({ ...w.pr, number: 'x' }) };
    const r = await gatePr(80, { gh });
    expect(r).toMatchObject({ state: 'failure', notChecked: true });
    expect(r.lines[0]).toBe('没查成：PR #80 读回来认不出：number 认不出。');
  });

  it('PR 读回来号不对：没查成', async () => {
    const w = world();
    const gh = { ...w.gh, pr: async () => ({ ...w.pr, number: 81 }) };
    const r = await gatePr(80, { gh });
    expect(r.lines[0]).toBe('没查成：要的是 PR #80，读回来的是 #81。');
  });
});

describe('入口：认出要算哪些 PR、写状态、退出码', () => {
  function eventFile(event: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), 'fleet-gate-event-')), 'event.json');
    writeFileSync(path, typeof event === 'string' ? event : JSON.stringify(event));
    return path;
  }
  const run = (w: { gh: GitHubReads }, eventName: string, event: unknown, over: { write?: boolean } = {}) =>
    runMergeGate({
      eventName,
      eventPath: eventFile(event),
      gh: w.gh,
      write: over.write ?? true,
      targetUrl: 'https://github.com/o/r/actions/runs/1',
    });
  const FLOW_REF = { head: { sha: HEAD, ref: 'fleet/12-t1a2b3c4d' } };

  it('PR 事件：算这一个，写到当前头上（通过也写，带详情链接）', async () => {
    const w = world();
    const r = await run(w, 'pull_request_target', { pull_request: { number: 80 } });
    expect(r.code).toBe(0);
    expect(w.written).toEqual([
      {
        sha: HEAD,
        state: 'success',
        description: '能合：不是引擎任务 PR，只看 CI。',
        targetUrl: 'https://github.com/o/r/actions/runs/1',
      },
    ]);
  });

  it('不通过也写（failure），退出码 0：算成了、写上了；没查成写 failure、退出码 2', async () => {
    const waiting = world({ prOver: FLOW_REF });
    expect((await run(waiting, 'pull_request_target', { pull_request: { number: 80 } })).code).toBe(0);
    expect(waiting.written[0]).toMatchObject({
      state: 'failure',
      description: expect.stringMatching(/^还没验/),
    });

    const broken = world({ prOver: FLOW_REF, broken: { statuses: '502' } });
    expect((await run(broken, 'pull_request_target', { pull_request: { number: 80 } })).code).toBe(2);
    expect(broken.written[0]).toMatchObject({
      state: 'failure',
      description: expect.stringMatching(/^没查成/),
    });
  });

  it('主线推送（工作流只在闸认的东西变了才触发它）：把开着的 PR 全重算，每个都写上状态', async () => {
    const w = world({ open: [{ number: 80 }, { number: 81 }] });
    const r = await run(w, 'push', { ref: 'refs/heads/main' });
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => l.startsWith('PR #'))).toEqual([
      'PR #80：merge-gate success',
      'PR #81：merge-gate success',
    ]);
    expect(w.written.map((s) => s.state)).toEqual(['success', 'success']);
  });

  it('主线推送时读不到开着的 PR 列表：没查成（退出码 2），一条状态都不写，不当成「没有要算的」', async () => {
    const w = world({ open: [{ number: 80 }] });
    w.broken.openPrs = '列表读不到';
    const r = await run(w, 'push', { ref: 'refs/heads/main' });
    expect(r.code).toBe(2);
    expect(r.lines).toEqual(['没查成：认不出这次要算哪些 PR（列表读不到）。']);
    expect(w.written).toEqual([]);
  });

  it('不认得的事件（比如 schedule）仍判没查成，一条状态都不写', async () => {
    const w = world({ open: [{ number: 80 }] });
    const r = await run(w, 'schedule', {});
    expect(r.code).toBe(2);
    expect(r.lines).toEqual(['没查成：不认得的事件 schedule。']);
    expect(w.written).toEqual([]);
  });

  it('已经关了的 PR 不写状态', async () => {
    const closed = world({ open: [{ number: 80 }], prOver: { state: 'closed' } });
    expect((await run(closed, 'workflow_dispatch', { inputs: { pr: '80' } })).lines).toEqual([
      'PR #80 已经关了，不算。',
    ]);
    expect(closed.written).toEqual([]);
  });

  it('冷调用状态：开着的 PR 全重算（不只事件里那个头的）；别的 context（含已经去掉的 second-opinion、「认领对得上」）不算', async () => {
    const w = world({ open: [{ number: 80 }, { number: 81 }] });
    // 【故意造出的失败】#351 演练：一轮对账给几个 PR 贴状态，排队组只留最后一次运行、事件里是最后那个 PR 的头——
    // 只算那一个的话，另一个 PR 就一直停在旧结论上；全重算了两个都写上
    await run(w, 'status', { context: 'cold-verify', sha: MERGE, state: 'success' });
    expect(w.written).toHaveLength(2);
    const other = world();
    expect(await run(other, 'status', { context: 'ci', sha: HEAD })).toEqual({
      code: 0,
      lines: ['这次没有要算的 PR。'],
    });
    // #1114：second-opinion 不再是闸的输入，这个状态写上来不用重算
    const old = world({ open: [{ number: 80 }] });
    expect(await run(old, 'status', { context: 'second-opinion', sha: HEAD, state: 'success' })).toEqual({
      code: 0,
      lines: ['这次没有要算的 PR。'],
    });
    // #444：合并闸不再判「认领对得上」
    const claimEvent = world({ open: [{ number: 80 }] });
    expect(await run(claimEvent, 'status', { context: '认领对得上', sha: HEAD, state: 'success' })).toEqual({
      code: 0,
      lines: ['这次没有要算的 PR。'],
    });
  });

  it('手动运行：填号算那一个，留空算全部', async () => {
    const w = world({ open: [{ number: 80 }, { number: 81 }] });
    await run(w, 'workflow_dispatch', { inputs: { pr: '80' } });
    expect(w.written).toHaveLength(1);
    await run(w, 'workflow_dispatch', { inputs: { pr: '' } });
    expect(w.written).toHaveLength(3);
  });

  it('只报不写（--no-write）：能合 0、不能合 1、没查成 2，一条状态都不写', async () => {
    const ev = { pull_request: { number: 80 } };
    const ok = world();
    expect((await run(ok, 'pull_request', ev, { write: false })).code).toBe(0);
    expect((await run(world({ prOver: FLOW_REF }), 'pull_request', ev, { write: false })).code).toBe(1);
    expect(
      (
        await run(world({ prOver: FLOW_REF, broken: { statuses: 'x' } }), 'pull_request', ev, {
          write: false,
        })
      ).code,
    ).toBe(2);
    expect(ok.written).toEqual([]);
  });

  it('故意坏掉的：事件读不到、认不出、事件名不认得、PR 列表读不到、手动填的号认不出、状态写不上、PR 都没读到', async () => {
    const w = world();
    const bad = await Promise.all([
      runMergeGate({
        eventName: undefined,
        eventPath: undefined,
        gh: w.gh,
        write: true,
      }),
      run(w, 'pull_request_target', '{不是 json'),
      run(w, 'pull_request_target', { issue: {} }),
      run(w, 'issue_comment', {}),
      run(world({ broken: { openPrs: '502' } }), 'status', { context: 'cold-verify', sha: HEAD }),
      run(w, 'workflow_dispatch', { inputs: { pr: 'x' } }),
      run(w, 'workflow_dispatch', { inputs: { pr: '#80' } }),
      run(world({ broken: { writeStatus: 'GitHub 回了 403' } }), 'pull_request_target', {
        pull_request: { number: 80 },
      }),
      run(world({ broken: { pr: 'GitHub 回了 502' } }), 'pull_request_target', {
        pull_request: { number: 80 },
      }),
    ]);
    for (const r of bad) expect(r.code).toBe(2);
    expect(bad[7]?.lines).toContain('  没写上状态（GitHub 回了 403）。');
    expect(bad[8]?.lines).toContain('  没写上状态：连 PR 的头都没读到。');
    expect(w.written).toEqual([]);
  });
});

describe('读写 GitHub（假的 fetch）', () => {
  type Call = { url: string; method: string; body: unknown; auth: string | null };
  function fakeFetch(respond: (url: string, method: string) => { status?: number; json?: unknown }) {
    const calls: Call[] = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: new Headers(init?.headers).get('authorization'),
      });
      const r = respond(String(url), method);
      return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200 });
    }) as typeof fetch;
    return { fn, calls };
  }
  const env = {
    GITHUB_TOKEN: 'token-for-test',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_API_URL: 'https://api.example/',
  };

  it('按仓拼地址，令牌只在请求头；写状态发 JSON', async () => {
    const f = fakeFetch(() => ({ json: { number: 80 } }));
    const gh = gateGitHub(ghApi(env, f.fn));
    await expect(gh.pr(80)).resolves.toEqual({ number: 80 });
    expect(f.calls[0]).toMatchObject({
      url: 'https://api.example/repos/o/r/pulls/80',
      auth: 'Bearer token-for-test',
    });
    await gh.writeStatus(HEAD, { state: 'failure', description: '等验收', targetUrl: 'https://x' });
    expect(f.calls.at(-1)).toMatchObject({
      url: `https://api.example/repos/o/r/statuses/${HEAD}`,
      method: 'POST',
      body: { state: 'failure', context: 'merge-gate', description: '等验收', target_url: 'https://x' },
    });
  });

  it('提交状态读逐条的列表，翻页读全；认不出、翻不完都抛', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ context: `c${i}`, state: 'success' }));
    const f = fakeFetch((url) =>
      url.endsWith('&page=1') ? { json: page1 } : { json: [{ context: 'last', state: 'success' }] },
    );
    await expect(gateGitHub(ghApi(env, f.fn)).statuses(HEAD)).resolves.toHaveLength(101);
    expect(f.calls[0]?.url).toBe(
      `https://api.example/repos/o/r/commits/${HEAD}/statuses?per_page=100&page=1`,
    );
    const junk = fakeFetch(() => ({ json: { sha: HEAD, total_count: 0, statuses: [] } }));
    await expect(gateGitHub(ghApi(env, junk.fn)).statuses(HEAD)).rejects.toThrow('第 1 页认不出（不是列表）');
    const endless = fakeFetch(() => ({ json: page1 }));
    await expect(gateGitHub(ghApi(env, endless.fn)).statuses(HEAD)).rejects.toThrow('没读完');
  });

  it('没有令牌、没有仓名、GitHub 回错都抛，报错里不带令牌', async () => {
    const ok = fakeFetch(() => ({ json: {} })).fn;
    const errors = await Promise.all([
      ghApi(env, fakeFetch(() => ({ status: 500 })).fn)
        .get('/pulls/1')
        .catch((e: Error) => e.message),
      ghApi({ ...env, GITHUB_TOKEN: '' }, ok)
        .get('/pulls/1')
        .catch((e: Error) => e.message),
      ghApi({ ...env, GITHUB_REPOSITORY: undefined }, ok)
        .get('/pulls/1')
        .catch((e: Error) => e.message),
      ghApi(env, fakeFetch(() => ({ status: 403 })).fn)
        .post('/statuses/x', {})
        .catch((e: Error) => e.message),
      ghApi(env, fakeFetch(() => ({ status: 500 })).fn)
        .getOrNull('/contents/x')
        .catch((e: Error) => e.message),
    ]);
    expect(errors).toEqual([
      'GitHub 回了 500（GET /pulls/1）',
      '没有 GITHUB_TOKEN',
      '没有 GITHUB_REPOSITORY（owner/名字）',
      'GitHub 回了 403（POST /statuses/x）',
      'GitHub 回了 500（GET /contents/x）',
    ]);
    for (const m of errors) expect(m).not.toContain('token-for-test');
  });
});
