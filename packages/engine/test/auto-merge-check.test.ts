// 开着的 PR 由对账兜底挂上自动合并（jobs/auto-merge-check.ts，#242）：一张 PR 是不是「机器人的、不是草稿、
// 没挂自动合并、CI 绿、不碰改标准路径」才挂上；条件不满足（草稿、人开的、已经挂上、CI 还红、碰了改标准）、
// 或读哪一步没读成的都不是挂上。每条失败路径都故意造一次：挂错或不挂不许只记一条扫描，都进没查成。
import { describe, expect, it } from 'vitest';
import {
  AUTO_MERGE_ALERT_PREFIX,
  type AutoMergeCheckDeps,
  checkAutoMerges,
  type PrAutoMergeCandidate,
} from '../src/jobs/auto-merge-check.ts';
import type { SweepPart } from '../src/jobs/reconcile-common.ts';

const REPO = { owner: 'acme', name: 'widgets' };
const noop = (): void => {};

interface Raised {
  dedupeKey: string;
  title: string;
  body: string;
}
interface Resolved {
  dedupeKey: string;
  why: string;
}

function pr(over: Partial<PrAutoMergeCandidate> = {}): PrAutoMergeCandidate {
  return {
    number: 88,
    nodeId: 'PR_88',
    state: 'open',
    draft: false,
    authorIsBot: true,
    autoMerge: false,
    headSha: 'a'.repeat(40),
    headRef: 'fix/widget-typo',
    ...over,
  };
}

interface World {
  deps: AutoMergeCheckDeps;
  raised: Raised[];
  resolved: Resolved[];
  enabled: { repo: string; number: number; nodeId: string }[];
}

interface Over {
  repos?: AutoMergeCheckDeps['repos'];
  listPrs?: AutoMergeCheckDeps['gh']['listPrs'];
  pullFiles?: AutoMergeCheckDeps['gh']['pullFiles'];
  checksEvaluate?: AutoMergeCheckDeps['gh']['checksEvaluate'];
  requiredChecks?: AutoMergeCheckDeps['gh']['requiredChecks'];
  readStandardPathsFile?: AutoMergeCheckDeps['gh']['readStandardPathsFile'];
  enableAutoMerge?: AutoMergeCheckDeps['gh']['enableAutoMerge'];
  listOpenByPrefix?: AutoMergeCheckDeps['autoMergeAlerts']['listOpenByPrefix'];
}

function world(o: Over = {}): World {
  const raised: Raised[] = [];
  const resolved: Resolved[] = [];
  const enabled: World['enabled'] = [];
  const deps: AutoMergeCheckDeps = {
    repos: o.repos ?? (async () => [REPO]),
    gh: {
      listPrs: o.listPrs ?? (async () => []),
      pullFiles: o.pullFiles ?? (async () => []),
      checksEvaluate: o.checksEvaluate ?? (async () => 'green'),
      requiredChecks: o.requiredChecks ?? (async () => ['check']),
      readStandardPathsFile:
        o.readStandardPathsFile ??
        (async () =>
          JSON.stringify({
            paths: [
              { path: 'packages/conventions/standard-paths.json', why: '清单本身' },
              { path: 'AGENTS.md', section: '通用段', why: '通用段' },
              { path: 'agents/**/*.md', why: '技能说明' },
            ],
          })),
      enableAutoMerge: async (repo, pull) => {
        enabled.push({ repo: `${repo.owner}/${repo.name}`, number: pull.number, nodeId: pull.nodeId });
        if (o.enableAutoMerge) await o.enableAutoMerge(repo, pull);
      },
    },
    autoMergeAlerts: {
      raise: async (input) => {
        raised.push({ dedupeKey: input.dedupeKey, title: input.title, body: input.body });
      },
      resolve: async (input) => {
        resolved.push({ dedupeKey: input.dedupeKey, why: input.why });
        return 'ok';
      },
      listOpenByPrefix: o.listOpenByPrefix ?? (async () => []),
    },
    log: noop,
  };
  return { deps, raised, resolved, enabled };
}

describe('开着的 PR 由对账兜底挂上自动合并', () => {
  it('一张机器人开的、不是草稿、没挂自动合并、CI 是绿的、不碰改标准路径的 PR：被挂上', async () => {
    const w = world({ listPrs: async () => [pr()] });
    const part = await checkAutoMerges(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 1, unchecked: [] });
    expect(w.enabled).toEqual([{ repo: 'acme/widgets', number: 88, nodeId: 'PR_88' }]);
    // 挂上之后就撤掉那条提醒（如果有）
    expect(w.resolved).toEqual([
      { dedupeKey: `${AUTO_MERGE_ALERT_PREFIX}acme/widgets#88`, why: '每小时对账挂上了自动合并' },
    ]);
    expect(w.raised).toEqual([]);
  });

  it('草稿、人开的、已经挂上自动合并的：不挂', async () => {
    const w = world({
      listPrs: async () => [
        pr({ number: 1, draft: true }),
        pr({ number: 2, authorIsBot: false }),
        pr({ number: 3, autoMerge: true }),
      ],
    });
    const part = await checkAutoMerges(w.deps);
    expect(part).toMatchObject({ scanned: 3, found: 0, unchecked: [] });
    expect(w.enabled).toEqual([]);
    expect(w.raised).toEqual([]);
    expect(w.resolved.map((r) => r.why)).toEqual([
      '这张 PR 还是草稿，挂上也没用（做完了点 Ready for review）',
      '不是我们机器人开的 PR，自动合并兜底不看它',
      '已经挂上了自动合并',
    ]);
  });

  it('【故意造出的失败】改到了改标准路径的：不挂，写明为什么', async () => {
    const w = world({
      listPrs: async () => [pr()],
      pullFiles: async () => [{ filename: 'packages/conventions/standard-paths.json', status: 'modified' }],
    });
    const part = await checkAutoMerges(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 0, unchecked: [] });
    expect(w.enabled).toEqual([]);
    expect(w.raised).toEqual([]);
    expect(w.resolved).toEqual([
      {
        dedupeKey: `${AUTO_MERGE_ALERT_PREFIX}acme/widgets#88`,
        why: '改到了改标准的路径，不挂：等创始人同意（或照先审后合人自己挂）',
      },
    ]);
  });

  it('【故意造出的失败】改到的是通配里的技能说明（agents/**/*.md）：不挂——只会前缀匹配的老判法会放过它', async () => {
    const w = world({
      listPrs: async () => [pr()],
      pullFiles: async () => [{ filename: 'agents/skills/discuss/SKILL.md', status: 'modified' }],
    });
    const part = await checkAutoMerges(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 0, unchecked: [] });
    expect(w.enabled).toEqual([]);
    expect(w.resolved[0]?.why).toContain('改标准');
  });

  it('【故意造出的失败】任务工作流的 PR（分支 fleet/<单号>-t<8 位>）：兜底不挂，也不读文件和清单——只有工作流在验收通过之后才挂', async () => {
    let read = 0;
    const w = world({
      listPrs: async () => [pr({ headRef: 'fleet/12-t1a2b3c4d' })],
      pullFiles: async () => {
        read += 1;
        return [];
      },
      readStandardPathsFile: async () => {
        read += 1;
        return '{}'; // 读了就会因为清单认不出而报提醒
      },
    });
    const part = await checkAutoMerges(w.deps);
    expect(part).toMatchObject({ scanned: 1, found: 0, unchecked: [] });
    expect(w.enabled).toEqual([]);
    expect(w.raised).toEqual([]);
    expect(read).toBe(0);
    expect(w.resolved[0]?.why).toContain('任务工作流的 PR');
  });

  it('像任务分支又不是的（编号位数不对、前缀不对）：照常当普通机器人 PR 看', async () => {
    const w = world({
      listPrs: async () => [
        pr({ number: 1, headRef: 'fleet/12-t1a2b3c4' }),
        pr({ number: 2, headRef: 'fleet/12-tXYZ12345' }),
        pr({ number: 3, headRef: 'feat/fleet/12-t1a2b3c4d' }),
      ],
    });
    const part = await checkAutoMerges(w.deps);
    expect(part).toMatchObject({ scanned: 3, found: 3, unchecked: [] });
    expect(w.enabled.map((e) => e.number)).toEqual([1, 2, 3]);
  });

  it('【故意造出的失败】CI 在这个头上还不绿（red / pending）：不挂', async () => {
    const w = world({ listPrs: async () => [pr()], checksEvaluate: async () => 'red' });
    const part = await checkAutoMerges(w.deps);
    expect(part.scanned).toBe(1);
    expect(part.found).toBe(0);
    expect(w.enabled).toEqual([]);
    expect(w.resolved[0]?.why).toContain('CI 在这个头上还不绿（是 red）');
  });

  it('【故意造出的失败】挂的时候 GitHub 报错：报提醒、写进没查成，不当成已经挂上', async () => {
    const w = world({
      listPrs: async () => [pr()],
      enableAutoMerge: async () => {
        throw new Error('GraphQL: Permission denied');
      },
    });
    const part = await checkAutoMerges(w.deps);
    expect(part.found).toBe(0);
    expect(part.unchecked).toEqual(['acme/widgets#88 GraphQL: Permission denied']);
    expect(w.raised).toHaveLength(1);
    expect(w.raised[0]?.dedupeKey).toBe(`${AUTO_MERGE_ALERT_PREFIX}acme/widgets#88`);
    expect(w.raised[0]?.body).toContain('GraphQL: Permission denied');
    expect(w.enabled).toEqual([{ repo: 'acme/widgets', number: 88, nodeId: 'PR_88' }]);
  });

  it('【故意造出的失败】读改到的文件没成 / 读清单没成 / 读必过检查没成：都报、都不挂', async () => {
    const w = world({
      listPrs: async () => [pr()],
      pullFiles: async () => {
        throw new Error('PR 文件列表读不了');
      },
    });
    expect((await checkAutoMerges(w.deps)).unchecked).toEqual(['acme/widgets#88 PR 文件列表读不了']);
    expect(w.raised).toHaveLength(1);

    const v = world({
      listPrs: async () => [pr()],
      readStandardPathsFile: async () => {
        throw new Error('主线上读不到 standard-paths.json');
      },
    });
    expect((await checkAutoMerges(v.deps)).unchecked).toEqual([
      'acme/widgets#88 读改标准路径清单没成：主线上读不到 standard-paths.json',
    ]);
    expect(v.raised).toHaveLength(1);

    const c = world({
      listPrs: async () => [pr()],
      requiredChecks: async () => {
        throw new Error('主线规则集里没有必过检查');
      },
    });
    expect((await checkAutoMerges(c.deps)).unchecked).toEqual(['acme/widgets#88 主线规则集里没有必过检查']);
    expect(c.raised).toHaveLength(1);
  });

  it('清单认不出：整个仓记没查成（挂不成一张也不挂）、不拿认不出当「没碰改标准」', async () => {
    const w = world({
      listPrs: async () => [pr()],
      readStandardPathsFile: async () => '{"paths":[]}',
    });
    expect((await checkAutoMerges(w.deps)).unchecked).toEqual([
      expect.stringContaining('acme/widgets#88 改标准路径清单认不出'),
    ] as unknown as string[]);
    expect(w.enabled).toEqual([]);
    expect(w.raised).toHaveLength(1);
  });

  it('不再开着的（合了、关了）那张旧提醒：撤了', async () => {
    const w = world({
      listPrs: async () => [],
      listOpenByPrefix: async () => [
        { dedupeKey: `${AUTO_MERGE_ALERT_PREFIX}acme/widgets#88` },
        { dedupeKey: `${AUTO_MERGE_ALERT_PREFIX}acme/other#9` },
      ],
    });
    const part = await checkAutoMerges(w.deps);
    expect(part.unchecked).toEqual([]);
    expect(w.resolved.map((r) => r.why)).toEqual([
      '这张 PR 不再开在我们受管的仓里、或这一轮没扫到它，这条提醒撤了',
      '这张 PR 不再开在我们受管的仓里、或这一轮没扫到它，这条提醒撤了',
    ]);
  });

  it('【故意造出的失败】开着的 PR 本身读不出来：这个仓写进没查成、不查', async () => {
    const w = world({
      listPrs: async () => {
        throw new Error('403');
      },
    });
    const part: SweepPart = await checkAutoMerges(w.deps);
    expect(part.unchecked).toEqual(['acme/widgets：读开着的 PR 没成：403']);
    expect(w.enabled).toEqual([]);
  });

  it('【故意造出的失败】列受管的仓没成：整个部分记 failed，不查也不当没事', async () => {
    const w = world({
      repos: async () => {
        throw new Error('库连不上');
      },
    });
    const part = await checkAutoMerges(w.deps);
    expect(part.failed).toBe('列受管的仓没成：库连不上');
    expect(w.enabled).toEqual([]);
  });

  it('PR 数超过上限：整个仓写进没查成、这一轮不查', async () => {
    const many = Array.from({ length: 101 }, (_, i) => pr({ number: 1000 + i }));
    const w = world({ listPrs: async () => many });
    const part = await checkAutoMerges(w.deps);
    expect(part.unchecked).toEqual([
      expect.stringContaining('开着的 PR 有 101 张，超过一次能看的 100'),
    ] as unknown as string[]);
    expect(w.enabled).toEqual([]);
  });

  it('提醒写不进 / 撤不掉：不拦着走、记进没查成、不能摞错误', async () => {
    const w = world({
      listPrs: async () => [],
      listOpenByPrefix: async () => [{ dedupeKey: `${AUTO_MERGE_ALERT_PREFIX}acme/widgets#88` }],
    });
    // 把 alerts.resolve 换成抛错的
    w.deps.autoMergeAlerts.resolve = async () => {
      throw new Error('提醒表写不了');
    };
    const part = await checkAutoMerges(w.deps);
    expect(part.unchecked).toEqual([`提醒 ${AUTO_MERGE_ALERT_PREFIX}acme/widgets#88 撤不掉：提醒表写不了`]);
  });
});
