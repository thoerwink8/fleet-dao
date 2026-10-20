import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ghApi, githubResponseEvidence, githubTransportEvidence } from '../src/gh-api.ts';
import {
  type GateDeps,
  type GateState,
  type GitHubReads,
  gateGitHub,
  gatePr,
  runMergeGate,
} from '../src/merge-gate.ts';
import { founderQuoteLine, GATE_LINE } from '../src/pr-columns.ts';

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
  /** PR 改到的文件（GitHub 文件列表的样子）。 */
  files: unknown[];
  /** 读了几次文件列表。 */
  fileReads: number;
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
    files: [],
    fileReads: 0,
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
    async files() {
      boom('files');
      w.fileReads += 1;
      return w.files;
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

  it('③ 【#1114 钉住】改到迁移（含 DROP）、ci.yml、鉴权、部署脚本的 PR：合并闸不再要第二意见——没有任何第二意见状态也放行；文件只用来判改标准', async () => {
    const w = world({
      files: [
        'packages/db/migrations/0042_drop_x.sql',
        '.github/workflows/ci.yml',
        'packages/api/src/auth.ts',
        'deploy/france.sh',
      ].map((filename) => ({ filename, status: 'modified' })),
      // 老的 second-opinion 状态就算是 failure / pending / 压根没有，也不影响结论
      statuses: [{ context: 'second-opinion', state: 'failure', description: '旧的状态' }],
    });
    const r = await gatePr(80, deps(w));
    expect(r.state).toBe('success');
    expect(r.notChecked).toBe(false);
    expect(r.lines.join('\n')).not.toContain('第二意见');
    expect(w.statusReads).toBe(0);
    // 读文件只有一个口子（files），用来判改标准；没有读内容、读别的仓的
    expect(Object.keys(w.gh).sort()).toEqual(['files', 'openPrs', 'pr', 'statuses', 'writeStatus']);
    expect(w.fileReads).toBe(1);
  });

  it('没碰改标准时正文里怎么写都一样：闸按分支名认引擎的 PR', async () => {
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

  it('不强制 CI 的引擎 PR：不看冷验收，也不读提交状态', async () => {
    const w = flowWorld();
    const r = await gatePr(80, { ...deps(w), ciPolicy: 'off' });
    expect(r.state).toBe('success');
    expect(r.lines).toEqual(['能合：这个仓不强制 CI，引擎任务 PR 不看冷验收。']);
    expect(w.statusReads).toBe(0);
  });

  it('没传模式的引擎 PR 仍要冷验收：不因为漏传把强制的仓放开', async () => {
    const r = await gatePr(80, deps(flowWorld()));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^还没验：/);
  });

  it('不强制 CI 的人手 PR：仍是「不是引擎任务 PR」，不套用引擎那句', async () => {
    const w = world();
    const r = await gatePr(80, { ...deps(w), ciPolicy: 'off' });
    expect(r.state).toBe('success');
    expect(r.lines).toEqual(['能合：不是引擎任务 PR，只看 CI。']);
    expect(w.statusReads).toBe(0);
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

describe('合并闸：改标准（人闸第四类，决定 0093）——碰了标准路径，正文里要有创始人原话', () => {
  const STD = 'packages/conventions/standard-paths.json';
  const QUOTE = founderQuoteLine('我都同意。', '2026-10-14 16:30 +0800');
  const touched = (filename: string, extra: Record<string, unknown> = {}) => ({
    filename,
    status: 'modified',
    ...extra,
  });

  it('碰了标准、正文没有原话 → failure，点名命中的路径和「缺创始人原话」', async () => {
    const w = world({
      files: [touched('packages/web/src/x.ts'), touched(STD), touched('agents/skills/a/SKILL.md')],
      prOver: { body: `**做了什么**：改清单\n\n**需求**：\nCloses #7\n${GATE_LINE}\n` },
    });
    const r = await gatePr(80, deps(w));
    expect(r).toMatchObject({ state: 'failure', notChecked: false });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^改标准缺创始人原话：碰了 /);
    expect(r.lines[0]).toContain(STD);
    expect(r.lines[0]).toContain('agents/skills/a/SKILL.md');
    expect(r.lines[0]).not.toContain('packages/web/src/x.ts');
  });

  it('【故意造出的失败】只写了「原话」二字、原话或时间是空的：都不算同意', async () => {
    for (const body of [
      '正文里提到原话，但没贴',
      '**创始人原话**：「」（2026-10-14 16:30）',
      '**创始人原话**：「同意」（ ）',
      '**创始人原话**：「同意」',
      '<!-- **创始人原话**：「同意」（2026-10-14） -->',
    ]) {
      const r = await gatePr(80, deps(world({ files: [touched(STD)], prOver: { body } })));
      expect(r.state, body).toBe('failure');
      expect(r.lines[0], body).toMatch(/缺创始人原话/);
    }
  });

  it('碰了标准、正文有 pnpm pr:open --founder-quote 写的那一行 → 不因此判红', async () => {
    const r = await gatePr(
      80,
      deps(
        world({
          files: [touched(STD)],
          prOver: { body: `**需求**：\nCloses #7\n${GATE_LINE}\n\n${QUOTE}\n` },
        }),
      ),
    );
    expect(r).toMatchObject({ state: 'success', notChecked: false });
    expect(r.lines).toEqual([
      '能合：不是引擎任务 PR，只看 CI。',
      `改标准：碰了 ${STD}，正文贴了创始人原话（2026-10-14 16:30 +0800）。`,
    ]);
  });

  it('手写的「创始人原话（时间）：「…」」也认（pr-open 的 --founder-approved 认的同一种）', async () => {
    const r = await gatePr(
      80,
      deps(
        world({
          files: [touched(STD)],
          prOver: { body: '**需求**：创始人原话（2026-10-11 03:48）：「你站在我的角度上去修」' },
        }),
      ),
    );
    expect(r.state).toBe('success');
  });

  it('改名：从标准目录挪出去也算碰了（旧名字也判）', async () => {
    const r = await gatePr(
      80,
      deps(
        world({
          files: [touched('docs/x.md', { status: 'renamed', previous_filename: 'agents/skills/a/SKILL.md' })],
        }),
      ),
    );
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toContain('agents/skills/a/SKILL.md');
  });

  it('引擎 PR 冷验收没过、又缺原话：两样都报，不通过的排前面', async () => {
    const r = await gatePr(
      80,
      deps(world({ files: [touched(STD)], prOver: { head: { sha: HEAD, ref: 'fleet/12-t1a2b3c4d' } } })),
    );
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^还没验：/);
    expect(r.lines[1]).toMatch(/^改标准缺创始人原话/);
  });

  it('没碰标准：结论和原来一样，正文怎么写都不管', async () => {
    const w = world({
      files: [touched('packages/web/src/x.ts'), touched('docs/design.md')],
      prOver: { body: '' },
    });
    const r = await gatePr(80, deps(w));
    expect(r).toMatchObject({ state: 'success', notChecked: false });
    expect(r.lines).toEqual(['能合：不是引擎任务 PR，只看 CI。']);
  });

  it('清单用的是传进来的那份（闸跑在主线检出上，读主线的清单）：清单里没有的路径不拦', async () => {
    const w = world({ files: [touched(STD)] });
    const r = await gatePr(80, {
      ...deps(w),
      standardPaths: async () => [{ path: 'agents/shared-rules.md', why: '通用段' }],
    });
    expect(r.state).toBe('success');
  });

  it('【故意造出的失败】文件列表读不到、超过上限读不全、认不出、清单读不到：没查成，不当成没碰', async () => {
    const cases: [Parameters<typeof world>[0], GateDeps['standardPaths'], RegExp][] = [
      [{ broken: { files: 'GitHub 回了 502' } }, undefined, /读不到 PR #80 改了哪些文件（GitHub 回了 502）/],
      [
        { broken: { files: 'PR #80 改的文件有 3000 个以上，GitHub 最多给这么多，读不全（拆小再开）' } },
        undefined,
        /3000 个以上.*读不全/,
      ],
      [{ files: [{ status: 'modified' }] }, undefined, /文件列表认不出：第 1 条没有 filename/],
      [
        {},
        async () => {
          throw new Error('清单认不出：paths 是空的');
        },
        /改标准的路径清单读不到（清单认不出：paths 是空的）/,
      ],
    ];
    for (const [over, standardPaths, line] of cases) {
      const w = world(over);
      const r = await gatePr(80, { ...deps(w), ...(standardPaths ? { standardPaths } : {}) });
      expect(r.state).toBe('failure');
      expect(r.notChecked).toBe(true);
      expect(r.lines.join('\n')).toMatch(line);
    }
  });

  it('【故意造出的失败】正文不是字符串（也不是 null）：PR 认不出，没查成', async () => {
    const r = await gatePr(80, deps(world({ prOver: { body: 42 } })));
    expect(r).toMatchObject({ state: 'failure', notChecked: true });
    expect(r.lines[0]).toMatch(/body 认不出/);
    // 空正文 GitHub 给 null：照常判
    expect((await gatePr(80, deps(world({ prOver: { body: null } })))).state).toBe('success');
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
        publication: { number: 80, lines: ['能合：不是引擎任务 PR，只看 CI。'], notChecked: false },
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

  it('pending只使required status失败，writer成功；独立probe仍退出1，真读写失败退出2', async () => {
    const pending = () =>
      world({
        prOver: FLOW_REF,
        statuses: [{ context: 'cold-verify', state: 'pending', description: 'running' }],
      });
    const w = pending();
    expect((await run(w, 'pull_request_target', { pull_request: { number: 80 } })).code).toBe(0);
    expect(w.written[0]).toMatchObject({ state: 'failure' });
    expect(w.written[0]?.description).toMatch(/^等验收：/);
    expect(
      (await run(pending(), 'pull_request_target', { pull_request: { number: 80 } }, { write: false })).code,
    ).toBe(1);
    const refused = world({
      prOver: FLOW_REF,
      statuses: [{ context: 'cold-verify', state: 'failure', description: 'failed' }],
    });
    expect((await run(refused, 'pull_request_target', { pull_request: { number: 80 } })).code).toBe(0);
    expect(refused.written[0]?.description).toMatch(/^验收没过：/);
    const writeFailed = pending();
    writeFailed.broken.writeStatus = '403';
    expect((await run(writeFailed, 'pull_request_target', { pull_request: { number: 80 } })).code).toBe(2);
    const readFailed = pending();
    readFailed.broken.statuses = '502';
    expect((await run(readFailed, 'pull_request_target', { pull_request: { number: 80 } })).code).toBe(2);
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
    expect(bad[7]?.lines).toContain('  最终核验或发表失败（GitHub 回了 403）。');
    expect(bad[7]?.lines).toContain('  失败状态也没写上（GitHub 回了 403）。');
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

  it('PR 文件列表翻页读满；认不出抛；30 页都满（GitHub 上限 3000 个）判读不全', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}`, status: 'modified' }));
    const f = fakeFetch((url) =>
      /&page=[12]$/.test(url) ? { json: full } : { json: [{ filename: 'last', status: 'added' }] },
    );
    await expect(gateGitHub(ghApi(env, f.fn)).files(80)).resolves.toHaveLength(201);
    expect(f.calls.map((c) => c.url)).toEqual(
      [1, 2, 3].map((p) => `https://api.example/repos/o/r/pulls/80/files?per_page=100&page=${p}`),
    );
    const junk = fakeFetch(() => ({ json: { files: [] } }));
    await expect(gateGitHub(ghApi(env, junk.fn)).files(80)).rejects.toThrow('第 1 页认不出（不是列表）');
    const capped = fakeFetch(() => ({ json: full }));
    await expect(gateGitHub(ghApi(env, capped.fn)).files(80)).rejects.toThrow('3000 个以上');
    expect(capped.calls).toHaveLength(30);
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
    const noHeaders = githubResponseEvidence(new Headers());
    expect(errors).toEqual([
      `GitHub 回了 500（GET /pulls/1）；${noHeaders}`,
      '没有 GITHUB_TOKEN',
      '没有 GITHUB_REPOSITORY（owner/名字）',
      `GitHub 回了 403（POST /statuses/x）；${noHeaders}`,
      `GitHub 回了 500（GET /contents/x）；${noHeaders}`,
    ]);
    for (const m of errors) expect(m).not.toContain('token-for-test');
  });
});

const EVIDENCE_SECRET = 'ghp_fakeSyntheticTokenValue3335';
const EVIDENCE_QUERY = 'synthetic-query-fake-3335';

async function evidenceLogs(run: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const previous = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const capture = (...args: unknown[]) => {
    logs.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  console.debug = capture;
  try {
    await run();
  } finally {
    console.log = previous.log;
    console.info = previous.info;
    console.warn = previous.warn;
    console.error = previous.error;
    console.debug = previous.debug;
  }
  return logs;
}

describe('正式 reader：ghApi 失败保留脱敏限流证据', () => {
  const env = {
    GITHUB_TOKEN: EVIDENCE_SECRET,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_API_URL: 'https://api.example/',
  };

  function scripted(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): {
    fn: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      return await respond(String(input), init);
    }) as typeof fetch;
    return { fn, calls };
  }

  it('403 remaining=0、429 retry-after、权限 403 和畸形头都失败，且不增加请求', async () => {
    const primary = {
      date: 'Mon, 19 Oct 2026 19:36:46 GMT',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1792442374',
      'x-ratelimit-resource': 'core',
    };
    const primaryFetch = scripted(
      () => new Response(JSON.stringify({ token: EVIDENCE_SECRET }), { status: 403, headers: primary }),
    );
    const logs = await evidenceLogs(async () => {
      const message = await ghApi(env, primaryFetch.fn)
        .get(`/pulls/3332?access_token=${EVIDENCE_QUERY}`)
        .catch((error: Error) => error.message);
      expect(message).toBe(
        `GitHub 回了 403（GET /pulls/3332）；${githubResponseEvidence(new Headers(primary))}`,
      );
      expect(message).toContain('reset=1792442374 utc=2026-10-19T20:39:34.000Z');
      expect(message).not.toContain(EVIDENCE_SECRET);
      expect(message).not.toContain(EVIDENCE_QUERY);
      expect(message).not.toContain('access_token');
      expect(message).not.toContain('已恢复');
    });
    expect(primaryFetch.calls).toEqual([
      `https://api.example/repos/o/r/pulls/3332?access_token=${EVIDENCE_QUERY}`,
    ]);
    expect(logs).toEqual([]);

    const secondary = scripted(
      () =>
        new Response('secondary', {
          status: 429,
          headers: { 'retry-after': 'Mon, 19 Oct 2026 19:40:00 GMT', 'x-ratelimit-resource': 'core' },
        }),
    );
    const limited = await ghApi(env, secondary.fn)
      .post('/statuses/x', { token: EVIDENCE_SECRET })
      .catch((error: Error) => error.message);
    expect(limited).toContain('GitHub 回了 429（POST /statuses/x）');
    expect(limited).toContain('retry-after=http-date:2026-10-19T19:40:00.000Z');
    expect(limited).not.toContain('secondary');
    expect(limited).not.toContain(EVIDENCE_SECRET);
    expect(secondary.calls).toHaveLength(1);

    const permission = scripted(() => new Response('{}', { status: 403 }));
    const denied = await ghApi(env, permission.fn)
      .get('/pulls/3332')
      .catch((error: Error) => error.message);
    expect(denied).toContain('GitHub 回了 403（GET /pulls/3332）');
    expect(denied).toContain('阶段=响应已收到');
    expect(denied).toContain('remaining=unknown');
    expect(denied).toContain('reset=unknown');
    expect(denied).not.toContain('remaining=0');
    expect(denied).not.toContain('已恢复');
    expect(permission.calls).toHaveLength(1);

    const malformed = scripted(
      () =>
        new Response(EVIDENCE_SECRET, {
          status: 403,
          headers: {
            'x-ratelimit-limit': '00',
            'x-ratelimit-remaining': `0 ${EVIDENCE_SECRET}`,
            'x-ratelimit-reset': 'not-a-date',
            'x-ratelimit-resource': 'audit_log',
            'retry-after': 'soon',
            'x-github-request-id': EVIDENCE_SECRET,
            cookie: EVIDENCE_SECRET,
            authorization: `Bearer ${EVIDENCE_SECRET}`,
          },
        }),
    );
    const bad = await ghApi(env, malformed.fn)
      .get('/pulls/3332')
      .catch((error: Error) => error.message);
    expect(bad).toContain('limit=unknown');
    expect(bad).toContain('remaining=unknown');
    expect(bad).toContain('reset=unknown');
    expect(bad).toContain('resource=unknown');
    expect(bad).toContain('retry-after=unknown');
    expect(bad).toContain('request-id=unknown');
    expect(bad).not.toContain(EVIDENCE_SECRET);
    expect(bad).not.toContain('audit_log');
    expect(bad).not.toContain('cookie');
    expect(bad).not.toContain('Bearer');
    expect(malformed.calls).toHaveLength(1);

    const missing = scripted(() => new Response(null, { status: 404 }));
    await expect(
      ghApi(env, missing.fn).getOrNull(`/contents/x?token=${EVIDENCE_SECRET}`),
    ).resolves.toBeNull();
    expect(missing.calls).toHaveLength(1);
  });

  it('没有响应时标明阶段，不抄 fetch 原文里的令牌', async () => {
    const failure = new TypeError(`socket ${EVIDENCE_SECRET} access_token=${EVIDENCE_QUERY}`, {
      cause: { code: `ECONNRESET ${EVIDENCE_SECRET}` },
    });
    const offline = scripted(() => {
      throw failure;
    });
    const message = await ghApi(env, offline.fn)
      .graphql(`query { token: "${EVIDENCE_SECRET}" }`, { token: EVIDENCE_SECRET })
      .catch((error: Error) => error.message);
    expect(message).toBe(`连不上 GitHub（POST /graphql）；${githubTransportEvidence(failure)}`);
    expect(message).toContain('阶段=响应未收到');
    expect(message).toContain('code=unknown');
    expect(message).not.toContain('阶段=响应已收到');
    expect(message).not.toContain(EVIDENCE_SECRET);
    expect(message).not.toContain(EVIDENCE_QUERY);
    expect(offline.calls).toHaveLength(1);
  });

  it('merge-gate 装配把读 PR 的 403 继续当成没查成', async () => {
    const headers = {
      date: 'Mon, 19 Oct 2026 19:36:46 GMT',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1792442374',
      'x-ratelimit-resource': 'core',
    };
    const fetch = scripted(
      () => new Response(JSON.stringify({ body: EVIDENCE_SECRET }), { status: 403, headers }),
    );
    const logs = await evidenceLogs(async () => {
      const result = await runMergeGate({
        eventName: 'pull_request',
        eventPath: undefined,
        gh: gateGitHub(ghApi(env, fetch.fn)),
        write: false,
        targetPr: 3332,
      });
      expect(result.code).toBe(2);
      const text = result.lines.join('\n');
      expect(text).toContain('没查成：读不到 PR #3332 现在的样子');
      expect(text).toContain(
        `GitHub 回了 403（GET /pulls/3332）；${githubResponseEvidence(new Headers(headers))}`,
      );
      expect(text).not.toContain('能合');
      expect(text).not.toContain(EVIDENCE_SECRET);
      expect(text).not.toContain('已恢复');
    });
    expect(fetch.calls).toEqual(['https://api.example/repos/o/r/pulls/3332']);
    expect(logs).toEqual([]);
  });
});
