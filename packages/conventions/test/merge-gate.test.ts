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
import type { RiskPath } from '../src/merge-gates.ts';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const PLAN = ['# 计划', '', '### P1 核心闭环', '', '- GitHub：两个新机器人。', ''].join('\n');
const RISK: RiskPath[] = [
  { path: 'deploy/', kind: '碰安全', why: '真机' },
  { path: 'packages/api/src/auth.ts', kind: '碰安全', why: '登录' },
];
const RISK_TEXT = JSON.stringify({ paths: RISK });

function body(tier: string | null): string {
  return [
    '**做了什么**：试一下',
    '**这个 PR 做完就关单**：否',
    '**对应计划**：P1「GitHub：两个新机器人」',
    '**specs**：specs/74-合并检查上GitHub/',
    ...(tier === null ? [] : [`**档位**：${tier}`]),
    '**文档**：不适用',
  ].join('\n');
}

interface World {
  pr: Record<string, unknown>;
  files: string[];
  statuses: unknown[];
  repoFiles: Record<string, Record<string, string>>;
  written: { sha: string; state: GateState; description: string; targetUrl?: string }[];
  refsRead: string[];
  /** 按方法名故意抛错。 */
  broken: Partial<Record<keyof GitHubReads, string>>;
  /** 前几次读 PR 时 mergeable 还是 null。 */
  unknownReads: number;
  open: Record<string, unknown>[];
  /** 每次读主线头依次回这些，读完了一直回最后一个。 */
  mains: string[];
  /** files 里这几个是删掉的（status removed）。 */
  removed: string[];
  /** 读了几次改动文件。 */
  filesReads: number;
}

function world(
  over: Partial<World> & { prOver?: Record<string, unknown> } = {},
): World & { gh: GitHubReads } {
  const w: World = {
    pr: {
      number: 80,
      title: '试一下',
      labels: [{ name: '杂项' }],
      milestone: { title: 'P1 核心闭环' },
      body: body('直接合——只改文档'),
      head: { sha: HEAD, ref: 'feat/x' },
      changed_files: 1,
      draft: false,
      mergeable: true,
      merge_commit_sha: MERGE,
      state: 'open',
      ...over.prOver,
    },
    files: ['docs/x.md'],
    statuses: [],
    repoFiles: {
      [MERGE]: { 'docs/plan.md': PLAN, 'specs/74-合并检查上GitHub': '' },
      [HEAD]: { 'docs/plan.md': PLAN, 'specs/74-合并检查上GitHub': '' },
    },
    written: [],
    refsRead: [],
    broken: {},
    unknownReads: 0,
    open: [],
    mains: [MAIN],
    removed: [],
    filesReads: 0,
    ...over,
  };
  if (over.files && !over.prOver?.changed_files) w.pr.changed_files = over.files.length;
  const boom = (k: keyof GitHubReads) => {
    if (w.broken[k]) throw new Error(w.broken[k]);
  };
  const gh: GitHubReads = {
    async pr(n) {
      boom('pr');
      if (w.unknownReads > 0) {
        w.unknownReads--;
        return { ...w.pr, number: n, mergeable: null };
      }
      return { ...w.pr, number: n };
    },
    async files() {
      w.filesReads += 1;
      boom('files');
      return w.files.map((filename) => ({
        filename,
        status: w.removed.includes(filename) ? 'removed' : 'modified',
      }));
    },
    async statuses() {
      boom('statuses');
      return w.statuses;
    },
    async fileAt(path, ref) {
      boom('fileAt');
      w.refsRead.push(ref);
      return w.repoFiles[ref]?.[path] ?? null;
    },
    async exists(path, ref) {
      boom('exists');
      return path in (w.repoFiles[ref] ?? {});
    },
    async openPrs() {
      boom('openPrs');
      return w.open;
    },
    async mainHead() {
      boom('mainHead');
      return (w.mains.length > 1 ? w.mains.shift() : w.mains[0]) as string;
    },
    async writeStatus(sha, s) {
      boom('writeStatus');
      w.written.push({ sha, ...s });
    },
  };
  return Object.assign(w, { gh });
}

const deps = (w: { gh: GitHubReads }, riskList: GateDeps['riskList'] = RISK): GateDeps => ({
  gh: w.gh,
  riskList,
  sleep: async () => {},
});

const SO_OK = [{ context: 'second-opinion', state: 'success', description: '通过' }];
/** #555-2：引擎任务工作流开的 PR 还要有一条通过的冷调用结论（另一个 context，闸只读）。 */
const CV_OK = [{ context: 'cold-verify', state: 'success', description: '验收通过' }];

describe('合并闸：验收场景', () => {
  it('① 不是草稿、没冲突、没改到先审后合的地方 → 通过；plan.md、specs 按合并后的样子读', async () => {
    const w = world();
    const r = await gatePr(80, deps(w));
    expect(r).toMatchObject({ number: 80, head: HEAD, state: 'success', notChecked: false });
    expect(r.lines).toEqual(['能合：不是草稿、没冲突，没改到先审后合的地方。']);
    expect(w.refsRead).toEqual([MERGE]);
  });

  it('② 和主线有冲突 → 不通过（按头读 plan.md 做提醒）', async () => {
    const w = world({ prOver: { mergeable: false, merge_commit_sha: null } });
    const r = await gatePr(80, deps(w));
    expect(r.state).toBe('failure');
    expect(r.lines).toEqual([expect.stringMatching(/^和主线有冲突，合不进去/)]);
    expect(w.refsRead).toEqual([HEAD]);
  });

  it('③ 草稿 → 不通过', async () => {
    const r = await gatePr(80, deps(world({ prOver: { draft: true } })));
    expect(r.state).toBe('failure');
    expect(r.lines).toEqual([expect.stringMatching(/^是草稿/)]);
  });

  it('④ 必填栏缺了（没标签、没里程碑、没档位、对应计划和 specs 都没写）→ 照样通过，只提醒', async () => {
    const r = await gatePr(80, deps(world({ prOver: { labels: [], milestone: null, body: '改了一行' } })));
    expect(r.state).toBe('success');
    expect(r.lines[0]).toBe('能合：不是草稿、没冲突，没改到先审后合的地方。');
    expect(r.lines.slice(1).map((l) => l.slice(0, l.indexOf('：', 3)))).toEqual([
      '提醒：没贴类别标签',
      '提醒：没挂里程碑',
      '提醒：正文里认不出「对应计划」一栏',
      '提醒：正文里认不出「specs」一栏',
      '提醒：正文里认不出「档位」一栏',
      '提醒：正文里认不出「这个 PR 做完就关单」一栏',
    ]);
  });

  it('④b 填了「是」却没写关单词（#460）→ 照样通过，只提醒该补 Closes；写了关单词就没有这条提醒', async () => {
    const yesBody = body('直接合——只改文档').replace('否', '是');
    const noWord = await gatePr(80, deps(world({ prOver: { body: yesBody } })));
    expect(noWord.state).toBe('success');
    expect(noWord.lines).toContainEqual(
      expect.stringMatching(/^提醒：「这个 PR 做完就关单」填了「是」，正文里却没有关单词/),
    );

    const withWord = await gatePr(80, deps(world({ prOver: { body: `${yesBody}\n\nCloses #12` } })));
    expect(withWord.state).toBe('success');
    expect(withWord.lines.join('\n')).not.toContain('却没有关单词');
  });

  it('⑤ 改到先审后合的路径、当前头没有第二意见 → 不通过，报出文件；档位写什么都一样（按路径判）', async () => {
    const files = ['deploy/france.sh', 'docs/x.md'];
    for (const tier of ['先审后合——改部署', '直接合——小改', null]) {
      const r = await gatePr(80, deps(world({ files, prOver: { body: body(tier) } })));
      expect(r.state, String(tier)).toBe('failure');
      expect(r.lines[0]).toMatch(
        /^等第二意见：当前头 aaaaaaa 上还没有 second-opinion 状态，改到了先审后合的地方：deploy\/france\.sh（碰安全）/,
      );
    }
    // 人手开的 PR 不要冷调用的结论：第二意见过了就放行（冷调用只管引擎任务工作流开的 PR）
    const passed = await gatePr(80, deps(world({ files, statuses: SO_OK })));
    expect(passed.state).toBe('success');
    expect(passed.lines[0]).toBe('能合：不是草稿、没冲突，改到 1 个先审后合的地方，当前头上第二意见已通过。');
  });

  it('没改到先审后合的地方：档位写「先审后合」也不等第二意见', async () => {
    const r = await gatePr(80, deps(world({ prOver: { body: body('先审后合——拿不准') } })));
    expect(r.state).toBe('success');
  });

  it('第二意见没过、还在跑 → 不通过', async () => {
    const at = (state: string) =>
      gatePr(
        80,
        deps(
          world({ files: ['packages/api/src/auth.ts'], statuses: [{ context: 'second-opinion', state }] }),
        ),
      );
    expect((await at('failure')).lines).toEqual([expect.stringMatching(/^第二意见没过/)]);
    expect((await at('pending')).lines).toEqual([expect.stringMatching(/^等第二意见：.*还在跑/)]);
  });
});

describe('合并闸：#555-2 引擎任务工作流开的 PR，合前一次冷调用的结论（cold-verify）也是输入', () => {
  /** 引擎任务工作流起的分支（fleet/<单号>-t<8 位>）。 */
  const FLOW = { head: { sha: HEAD, ref: 'fleet/12-t1a2b3c4d' } };
  const flowWorld = (over: Parameters<typeof world>[0] = {}) =>
    world({ ...over, prOver: { ...FLOW, ...over.prOver } });

  it('引擎的 PR、还没有冷调用结论 → 不通过，写明「还没验」和为什么要验（哪怕没碰任何先审后合的路径）', async () => {
    const r = await gatePr(80, deps(flowWorld()));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^还没验：当前头 aaaaaaa 上没有 cold-verify 状态/);
    expect(r.lines[0]).toContain('引擎任务工作流开的 PR');
  });

  it('引擎的 PR、冷调用通过 → 通过；没碰先审后合的路径就不等第二意见', async () => {
    const r = await gatePr(80, deps(flowWorld({ statuses: CV_OK })));
    expect(r.state).toBe('success');
    expect(r.lines[0]).toBe('能合：不是草稿、没冲突，没改到先审后合的地方，引擎任务 PR 的验收那一遍也通过。');
  });

  it('引擎的 PR 又碰了先审后合的路径：第二意见和冷调用两条都要，缺哪条报哪条，各认各的 context', async () => {
    const files = ['deploy/france.sh'];
    const onlyCv = await gatePr(80, deps(flowWorld({ files, statuses: CV_OK })));
    expect(onlyCv.state).toBe('failure');
    expect(onlyCv.lines[0]).toMatch(/^等第二意见：/);
    const onlySo = await gatePr(80, deps(flowWorld({ files, statuses: SO_OK })));
    expect(onlySo.state).toBe('failure');
    expect(onlySo.lines[0]).toContain('没有 cold-verify 状态');
    const both = await gatePr(80, deps(flowWorld({ files, statuses: [...SO_OK, ...CV_OK] })));
    expect(both.state).toBe('success');
    expect(both.lines[0]).toBe(
      '能合：不是草稿、没冲突，改到 1 个先审后合的地方，当前头上第二意见已通过，引擎任务 PR 的验收那一遍也通过。',
    );
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

  it('人手开的 PR（分支名不是引擎的）：压根不等这条状态——哪怕碰了先审后合的路径，也只要第二意见', async () => {
    const r = await gatePr(
      80,
      deps(
        world({
          files: ['deploy/france.sh'],
          statuses: [...SO_OK, { context: 'cold-verify', state: 'failure', description: '别的 PR 的结论' }],
        }),
      ),
    );
    expect(r.state).toBe('success');
    expect(r.lines[0]).toBe('能合：不是草稿、没冲突，改到 1 个先审后合的地方，当前头上第二意见已通过。');
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

  it('引擎的 PR、先审后合的清单读不到：照样要冷调用结论（要不要验和清单无关），清单那条「没查成」也照样报', async () => {
    const r = await gatePr(
      80,
      deps(flowWorld({ files: ['deploy/france.sh'], statuses: CV_OK }), '不是合法的 JSON'),
    );
    expect(r.state).toBe('failure');
    expect(r.notChecked).toBe(true);
    expect(r.lines.join('\n')).toContain('没法判改没改到先审后合的地方');
    const missing = await gatePr(80, deps(flowWorld({ files: ['deploy/france.sh'] }), '不是合法的 JSON'));
    expect(missing.lines.join('\n')).toContain('没有 cold-verify 状态');
  });
});

describe('合并闸：#444 起不再判「认领对得上」「写了关单却没带结果.md」（缺的由每天的关单对账另外提醒，不挡合并）', () => {
  const linkedBody = (column: string, tail = '') =>
    body('CI 绿就合——只改文档').replace(
      '**这个 PR 做完就关单**：否',
      `**需求**：#12\n**这个 PR 做完就关单**：${column}`,
    ) + (tail ? `\n\n${tail}` : '');

  it('【故意造出的失败】只缺「认领对得上」：挂了单、这个状态压根没贴，或引擎贴过「认领对不上」（failure），合并闸都不查这个，照样判能合', async () => {
    const noStatus = await gatePr(80, deps(world({ prOver: { body: linkedBody('否') } })));
    expect(noStatus.state).toBe('success');
    expect(noStatus.lines.join('\n')).not.toContain('认领');

    const claimFailed = { context: '认领对得上', state: 'failure', description: '认领作废了，改派给了别人' };
    const claimMismatch = await gatePr(
      80,
      deps(world({ prOver: { body: linkedBody('否') }, statuses: [claimFailed] })),
    );
    expect(claimMismatch.state).toBe('success');
    expect(claimMismatch.lines.join('\n')).not.toContain('认领');
  });

  it('【故意造出的失败】只缺结果文档：写了 Closes #12、改动里没有 specs/12-*/结果.md，合并闸不查这个，照样判能合，也不为它多读一次改动文件', async () => {
    const w = world({ prOver: { body: linkedBody('是', 'Closes #12') } });
    const r = await gatePr(80, deps(w));
    expect(r.state).toBe('success');
    expect(r.lines.join('\n')).not.toContain('结果');
    expect(w.filesReads).toBe(1); // 只有算高风险路径那一次，closingCheck 已经不在了
  });
});

describe('合并闸：GitHub 还在算冲突', () => {
  it('先是 null、再读几次算出来了 → 照常判', async () => {
    const w = world({ unknownReads: 2 });
    expect((await gatePr(80, deps(w))).state).toBe('success');
  });

  it('一直算不出来 → pending，不当通过', async () => {
    const w = world({ unknownReads: 99 });
    const r = await gatePr(80, { ...deps(w), mergeablePolls: 3 });
    expect(r).toMatchObject({ state: 'pending', notChecked: false });
    expect(r.lines[0]).toMatch(/^GitHub 还没算完/);
  });
});

describe('合并闸：决定结论的读不到、认不出都是「没查成」，写 failure，不当通过', () => {
  const RISKY = ['deploy/france.sh'];
  const cases: [string, Parameters<typeof world>[0], GateDeps['riskList'] | undefined, RegExp][] = [
    [
      'PR 读不到',
      { broken: { pr: 'GitHub 回了 502' } },
      undefined,
      /^没查成：读不到 PR #80 现在的样子（GitHub 回了 502）/,
    ],
    ['PR 没有头', { prOver: { head: {} } }, undefined, /head\.sha 认不出/],
    ['PR 的 draft 认不出', { prOver: { draft: 'no' } }, undefined, /draft 认不出/],
    ['改动文件读不到', { broken: { files: '500' } }, undefined, /读不到 PR #80 改了哪些文件（500）/],
    ['改动文件没读全', { prOver: { changed_files: 3001 } }, undefined, /改了 3001 个文件，只读到 1 个/],
    ['先审后合的清单读不到', {}, '读不到', /路径清单 .* 读不到/],
    [
      '提交状态读不到',
      { files: RISKY, broken: { statuses: '502' } },
      undefined,
      /读不到当前头 aaaaaaa 的提交状态（502）/,
    ],
    [
      '提交状态认不出',
      { files: RISKY, statuses: [{ context: 'second-opinion', state: '通过' }] },
      undefined,
      /提交状态认不出/,
    ],
  ];

  it.each(cases)('%s', async (_name, over, riskList, line) => {
    const r = await gatePr(80, deps(world(over), riskList ?? RISK));
    expect(r.state).toBe('failure');
    expect(r.notChecked).toBe(true);
    expect(r.lines[0]).toMatch(/^没查成：/);
    expect(r.lines.join('\n')).toMatch(line);
  });

  it('PR 读回来没有号：没查成', async () => {
    const w = world();
    const gh = { ...w.gh, pr: async () => ({ ...w.pr, number: 'x' }) };
    const r = await gatePr(80, { ...deps(w), gh });
    expect(r).toMatchObject({ state: 'failure', notChecked: true });
    expect(r.lines[0]).toBe('没查成：PR #80 读回来认不出：number 认不出。');
  });

  it('PR 读回来号不对：没查成', async () => {
    const w = world();
    const gh = { ...w.gh, pr: async () => ({ ...w.pr, number: 81 }) };
    const r = await gatePr(80, { ...deps(w), gh });
    expect(r.lines[0]).toBe('没查成：要的是 PR #80，读回来的是 #81。');
  });
});

describe('合并闸：提醒那一半坏了也改不了结论（所以必填栏的判法不在先审后合清单里）', () => {
  const cases: [string, Parameters<typeof world>[0], RegExp][] = [
    ['标签认不出', { prOver: { labels: 'x' } }, /提醒：必填栏没查成：.*labels 认不出/],
    ['plan.md 读不到', { repoFiles: {} }, /提醒：必填栏没查成：这个 PR 里读不到 docs\/plan\.md/],
    ['plan.md 没有阶段', { repoFiles: { [MERGE]: { 'docs/plan.md': '# 空' } } }, /一个阶段.*也没认出来/],
    ['plan.md 读的时候出错', { broken: { fileAt: '超时' } }, /或 specs 目录（超时）/],
    ['specs 目录问的时候出错', { broken: { exists: '403' } }, /或 specs 目录（403）/],
  ];

  it.each(cases)('%s：没改到先审后合的地方照样通过，提醒里写明没查成', async (_name, over, line) => {
    const r = await gatePr(80, deps(world(over)));
    expect(r.state).toBe('success');
    expect(r.lines.join('\n')).toMatch(line);
  });

  it('改到先审后合的地方、没有第二意见：提醒那一半坏了照样不通过', async () => {
    const r = await gatePr(80, deps(world({ files: ['deploy/x.sh'], broken: { fileAt: '超时' } })));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^等第二意见/);
  });
});

describe('入口：认出要算哪些 PR、写状态、退出码', () => {
  function eventFile(event: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), 'fleet-gate-event-')), 'event.json');
    writeFileSync(path, typeof event === 'string' ? event : JSON.stringify(event));
    return path;
  }
  const run = (
    w: { gh: GitHubReads },
    eventName: string,
    event: unknown,
    over: { write?: boolean; risk?: string | undefined } = {},
  ) =>
    runMergeGate({
      eventName,
      eventPath: eventFile(event),
      riskListText: 'risk' in over ? over.risk : RISK_TEXT,
      gh: w.gh,
      write: over.write ?? true,
      targetUrl: 'https://github.com/o/r/actions/runs/1',
      sleep: async () => {},
    });

  it('PR 事件：算这一个，写到当前头上（通过也写，带详情链接）', async () => {
    const w = world();
    const r = await run(w, 'pull_request_target', { pull_request: { number: 80 } });
    expect(r.code).toBe(0);
    expect(w.written).toEqual([
      {
        sha: HEAD,
        state: 'success',
        description: '能合：不是草稿、没冲突，没改到先审后合的地方。',
        targetUrl: 'https://github.com/o/r/actions/runs/1',
      },
    ]);
  });

  it('不通过也写（failure），退出码 0：算成了、写上了；没查成写 failure、退出码 2', async () => {
    const draft = world({ prOver: { draft: true } });
    expect((await run(draft, 'pull_request_target', { pull_request: { number: 80 } })).code).toBe(0);
    expect(draft.written[0]).toMatchObject({
      state: 'failure',
      description: expect.stringMatching(/^是草稿/),
    });

    const noList = world();
    expect(
      (await run(noList, 'pull_request_target', { pull_request: { number: 80 } }, { risk: undefined })).code,
    ).toBe(2);
    expect(noList.written[0]).toMatchObject({
      state: 'failure',
      description: expect.stringMatching(/^没查成/),
    });
  });

  it('主线推送：逐个算所有开着的 PR；关了的不写', async () => {
    const w = world({ open: [{ number: 80 }, { number: 81 }] });
    const r = await run(w, 'push', { ref: 'refs/heads/main' });
    expect(r.code).toBe(0);
    expect(w.written).toHaveLength(2);
    const closed = world({ open: [{ number: 80 }], prOver: { state: 'closed' } });
    expect((await run(closed, 'push', {})).lines).toEqual(['PR #80 已经关了，不算。']);
    expect(closed.written).toEqual([]);
  });

  it('第二意见状态：开着的 PR 全重算（不只事件里那个头的）；别的 context（包括「认领对得上」，#444 起）不算', async () => {
    const w = world({ open: [{ number: 80 }, { number: 81 }] });
    // 【故意造出的失败】#351 演练：一轮对账给几个 PR 贴状态，排队组只留最后一次运行、事件里是最后那个 PR 的头——
    // 只算那一个的话，另一个 PR 就一直停在旧结论上；全重算了两个都写上
    await run(w, 'status', { context: 'second-opinion', sha: MERGE, state: 'success' });
    expect(w.written).toHaveLength(2);
    const other = world();
    expect(await run(other, 'status', { context: 'ci', sha: HEAD })).toEqual({
      code: 0,
      lines: ['这次没有要算的 PR。'],
    });
    // #444：合并闸不再判「认领对得上」，这个状态写上来不用重算了
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
    expect((await run(world({ prOver: { draft: true } }), 'pull_request', ev, { write: false })).code).toBe(
      1,
    );
    expect((await run(world({ broken: { files: 'x' } }), 'pull_request', ev, { write: false })).code).toBe(2);
    expect(ok.written).toEqual([]);
  });

  it('故意坏掉的：事件读不到、认不出、事件名不认得、PR 列表读不到、手动填的号认不出、状态写不上、PR 都没读到', async () => {
    const w = world();
    const bad = await Promise.all([
      runMergeGate({
        eventName: undefined,
        eventPath: undefined,
        riskListText: RISK_TEXT,
        gh: w.gh,
        write: true,
      }),
      run(w, 'pull_request_target', '{不是 json'),
      run(w, 'pull_request_target', { issue: {} }),
      run(w, 'issue_comment', {}),
      run(world({ broken: { openPrs: '502' } }), 'push', {}),
      run(world({ broken: { openPrs: '502' } }), 'status', { context: 'second-opinion', sha: HEAD }),
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
    expect(bad[8]?.lines).toContain('  没写上状态（GitHub 回了 403）。');
    expect(bad[9]?.lines).toContain('  没写上状态：连 PR 的头都没读到。');
    expect(w.written).toEqual([]);
  });

  it('主线在这次运行里变了：不写回（旧结果不盖新结果）；读不到主线头：没查成、一条都不写', async () => {
    const moved = world({ open: [{ number: 80 }, { number: 81 }], mains: [MAIN, MAIN, MERGE] });
    const r = await run(moved, 'push', {});
    expect(r.code).toBe(0);
    expect(moved.written.map((x) => x.sha)).toEqual([HEAD]);
    expect(r.lines.at(-1)).toMatch(/^主线在这次运行里变了（ccccccc → bbbbbbb），剩下的不写回/);

    const blind = world({ broken: { mainHead: 'GitHub 回了 502' } });
    const b = await run(blind, 'pull_request_target', { pull_request: { number: 80 } });
    expect(b.code).toBe(2);
    expect(b.lines[0]).toMatch(/^没查成：读不到主线现在的头（GitHub 回了 502）/);
    expect(blind.written).toEqual([]);
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

  it('按仓拼地址，令牌只在请求头；404 在问「在不在」时回 null；写状态发 JSON', async () => {
    const f = fakeFetch((url) => (url.includes('/contents/') ? { status: 404 } : { json: { number: 80 } }));
    const gh = gateGitHub(ghApi(env, f.fn));
    await expect(gh.pr(80)).resolves.toEqual({ number: 80 });
    expect(f.calls[0]).toMatchObject({
      url: 'https://api.example/repos/o/r/pulls/80',
      auth: 'Bearer token-for-test',
    });
    await expect(gh.exists('specs/74-合并检查上GitHub', HEAD)).resolves.toBe(false);
    expect(f.calls[1]?.url).toBe(
      `https://api.example/repos/o/r/contents/specs/${encodeURIComponent('74-合并检查上GitHub')}?ref=${HEAD}`,
    );
    await expect(gh.fileAt('docs/plan.md', HEAD)).resolves.toBeNull();
    await gh.writeStatus(HEAD, { state: 'failure', description: '是草稿', targetUrl: 'https://x' });
    expect(f.calls.at(-1)).toMatchObject({
      url: `https://api.example/repos/o/r/statuses/${HEAD}`,
      method: 'POST',
      body: { state: 'failure', context: 'merge-gate', description: '是草稿', target_url: 'https://x' },
    });
  });

  it('文件内容按 base64 解开；不是文件的认不出', async () => {
    const content = Buffer.from('# 计划', 'utf8').toString('base64');
    const ok = gateGitHub(
      ghApi(env, fakeFetch(() => ({ json: { type: 'file', encoding: 'base64', content } })).fn),
    );
    await expect(ok.fileAt('docs/plan.md', HEAD)).resolves.toBe('# 计划');
    const dir = gateGitHub(ghApi(env, fakeFetch(() => ({ json: [] })).fn));
    await expect(dir.fileAt('docs', HEAD)).rejects.toThrow('docs 读回来认不出');
  });

  it('改动文件翻页读全，状态、改动内容、改名前的名字都收；认不出的一条抛', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}`, status: 'modified' }));
    const f = fakeFetch((url) =>
      url.endsWith('&page=1')
        ? { json: page1 }
        : {
            json: [
              { filename: 'new.ts', status: 'renamed', previous_filename: 'deploy/old.sh', patch: '+x' },
            ],
          },
    );
    const got = await gateGitHub(ghApi(env, f.fn)).files(80);
    expect(got).toHaveLength(101);
    expect(got[100]).toEqual({
      filename: 'new.ts',
      status: 'renamed',
      previous: 'deploy/old.sh',
      patch: '+x',
    });
    const bad = gateGitHub(ghApi(env, fakeFetch(() => ({ json: [{ name: 'x' }] })).fn));
    await expect(bad.files(80)).rejects.toThrow('没有 filename、status');
    const notList = gateGitHub(ghApi(env, fakeFetch(() => ({ json: { message: 'x' } })).fn));
    await expect(notList.files(80)).rejects.toThrow('不是列表');
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

  it('主线头：先问默认分支再读它的头；认不出的抛', async () => {
    const answer = (repo: unknown, ref: unknown) =>
      fakeFetch((url) => (url.endsWith('/repos/o/r') ? { json: repo } : { json: ref }));
    const ok = answer({ default_branch: 'main' }, { object: { sha: MAIN } });
    await expect(gateGitHub(ghApi(env, ok.fn)).mainHead()).resolves.toBe(MAIN);
    expect(ok.calls.map((c) => c.url)).toEqual([
      'https://api.example/repos/o/r',
      'https://api.example/repos/o/r/git/ref/heads/main',
    ]);
    await expect(gateGitHub(ghApi(env, answer({}, {}).fn)).mainHead()).rejects.toThrow(
      'default_branch 认不出',
    );
    await expect(
      gateGitHub(ghApi(env, answer({ default_branch: 'main' }, { object: {} }).fn)).mainHead(),
    ).rejects.toThrow('主线 main 的头认不出');
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
