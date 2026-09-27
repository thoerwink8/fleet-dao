// 每小时对账的第三项：GitHub 两个机器人的权限自检（jobs/github-app-check.ts）。缺权限、多了不该有的、没查成、列不了仓、
// 自检整个没跑成，各故意造一次：都报出来（提醒或这一轮没查全），不许当成权限够；权限好了下一轮自己撤。
import { type AlertRow, GITHUB_APP_ALERT_PREFIX } from '@fleet-dao/db';
import type { RepoRef, SelfCheckItem } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import {
  checkGitHubApps,
  type GitHubAppCheckDeps,
  githubAppAlert,
  githubAppAlertKey,
} from '../src/jobs/github-app-check.ts';
import { RECONCILE_ACTOR } from '../src/jobs/reconcile-common.ts';

const REPO: RepoRef = { owner: 'acme', name: 'widgets' };

const item = (over: Partial<SelfCheckItem> = {}): SelfCheckItem => ({
  role: 'engine',
  repo: 'acme/widgets',
  ok: true,
  missing: [],
  extra: [],
  ...over,
});

const openAlert = (dedupeKey: string): AlertRow => ({
  id: 'n1',
  dedupeKey,
  level: 'alert',
  taskId: null,
  title: '旧的',
  body: '旧的',
  link: null,
  createdAt: new Date('2026-09-27T10:00:00.000Z'),
  updatedAt: new Date('2026-09-27T10:00:00.000Z'),
  resolvedAt: null,
  resolvedBy: null,
});

interface World {
  deps: GitHubAppCheckDeps;
  raised: { dedupeKey: string; level: string; title: string; body: string }[];
  resolved: { dedupeKey: string; by: string; why: string }[];
  asked: RepoRef[][];
}

function world(
  items: SelfCheckItem[] | Error,
  over: { repos?: () => Promise<RepoRef[]>; open?: string[] } = {},
): World {
  const raised: World['raised'] = [];
  const resolved: World['resolved'] = [];
  const asked: RepoRef[][] = [];
  const open = new Set(over.open ?? []);
  const deps: GitHubAppCheckDeps = {
    apps: {
      repos: over.repos ?? (async () => [REPO]),
      async selfCheck(repos) {
        asked.push(repos);
        if (items instanceof Error) throw items;
        return items;
      },
    },
    alerts: {
      byKey: async (key) => (open.has(key) ? openAlert(key) : null),
      async raise(input) {
        raised.push({ dedupeKey: input.dedupeKey, level: input.level, title: input.title, body: input.body });
      },
      async resolve(input) {
        resolved.push({ dedupeKey: input.dedupeKey, by: input.by, why: input.why });
        return 'ok';
      },
    },
  };
  return { deps, raised, resolved, asked };
}

describe('GitHub 机器人权限自检（每小时对账的一项）', () => {
  it('提醒的键：github-app:<机器人>:<仓>（后端健康页按前缀找）', () => {
    expect(githubAppAlertKey({ role: 'engine', repo: 'acme/widgets' })).toBe(
      'github-app:engine:acme/widgets',
    );
    expect(GITHUB_APP_ALERT_PREFIX).toBe('github-app:');
  });

  it('两个机器人权限都够：一条提醒都不报，看了几个照记', async () => {
    const w = world([item({ role: 'agent' }), item()]);
    expect(await checkGitHubApps(w.deps)).toEqual({ scanned: 2, found: 0, unchecked: [] });
    expect(w.asked).toEqual([[REPO]]);
    expect(w.raised).toEqual([]);
    expect(w.resolved).toEqual([]);
  });

  it('【故意造出的失败】「引擎」缺 statuses:write（设置里加了、安装处没点接受）：报一条要人看，写明贴不了「认领对得上」', async () => {
    const w = world([item({ role: 'agent' }), item({ ok: false, missing: ['statuses:write'] })]);
    expect(await checkGitHubApps(w.deps)).toEqual({ scanned: 2, found: 1, unchecked: [] });
    expect(w.raised).toHaveLength(1);
    expect(w.raised[0]).toMatchObject({
      dedupeKey: 'github-app:engine:acme/widgets',
      level: 'alert',
      title: '「引擎」机器人在 acme/widgets 上的权限不对：缺 statuses:write',
    });
    expect(w.raised[0]?.body).toContain('点接受新权限');
    expect(w.raised[0]?.body).toContain('认领对得上');
  });

  it('【故意造出的失败】「干活的」多了 issues:write：权限「够」也照报（不该有的写权限）', async () => {
    const w = world([item({ role: 'agent', extra: ['issues:write'] }), item()]);
    expect(await checkGitHubApps(w.deps)).toMatchObject({ found: 1, unchecked: [] });
    expect(w.raised[0]).toMatchObject({
      dedupeKey: 'github-app:agent:acme/widgets',
      title: '「干活的」机器人在 acme/widgets 上的权限不对：多了不该有的 issues:write',
    });
  });

  it('【故意造出的失败】没查成（没装到这个仓）：报提醒、这一轮记没查全，不当成权限够', async () => {
    const why =
      '「引擎」机器人没查成：「引擎」机器人没装到 acme/widgets（或这个仓不存在）：到 App 设置页把它装到这个仓';
    const w = world([item({ role: 'agent' }), item({ ok: false, why })]);
    const part = await checkGitHubApps(w.deps);
    expect(part).toEqual({ scanned: 2, found: 1, unchecked: [`acme/widgets：${why}`] });
    expect(w.raised[0]).toMatchObject({
      dedupeKey: 'github-app:engine:acme/widgets',
      title: '「引擎」机器人在 acme/widgets 上的权限没查成',
    });
    expect(w.raised[0]?.body.startsWith(why)).toBe(true);
    expect(w.raised[0]?.body).toContain('按权限不够算');
  });

  it('权限好了：开着的那条自己撤（处理人是每小时对账）；没开着的不去撤', async () => {
    const w = world([item({ role: 'agent' }), item()], { open: ['github-app:engine:acme/widgets'] });
    expect(await checkGitHubApps(w.deps)).toEqual({ scanned: 2, found: 1, unchecked: [] });
    expect(w.resolved).toEqual([
      {
        dedupeKey: 'github-app:engine:acme/widgets',
        by: RECONCILE_ACTOR,
        why: '「引擎」机器人在 acme/widgets 上的权限够了（每小时对账自检读回）',
      },
    ]);
    expect(w.raised).toEqual([]);
  });

  it('【故意造出的失败】列不了受管的仓：这一项整个没跑成，不去自检、不报「够了」', async () => {
    const w = world([item()], {
      repos: async () => {
        throw new Error('库连不上');
      },
    });
    expect(await checkGitHubApps(w.deps)).toEqual({
      failed: 'GitHub 机器人权限自检：列受管的仓没成：库连不上',
      scanned: 0,
      found: 0,
      unchecked: [],
    });
    expect(w.asked).toEqual([]);
  });

  it('【故意造出的失败】自检整个抛错（凭据读不到）：这一项没跑成，照实写原因', async () => {
    const w = world(new Error('引擎的 App 私钥读不到'));
    expect(await checkGitHubApps(w.deps)).toEqual({
      failed: 'GitHub 机器人权限自检没跑成：引擎的 App 私钥读不到',
      scanned: 0,
      found: 0,
      unchecked: [],
    });
  });

  it('【故意造出的失败】提醒写不进库：记没查全（写明哪条），不吞掉', async () => {
    const w = world([item({ ok: false, missing: ['statuses:write'] })]);
    w.deps.alerts.raise = async () => {
      throw new Error('库连不上');
    };
    expect(await checkGitHubApps(w.deps)).toEqual({
      scanned: 1,
      found: 0,
      unchecked: ['github-app:engine:acme/widgets 的提醒没写成：库连不上'],
    });
  });

  it('没有受管的仓：什么都不查，记看了 0 个（和别的部分一起并，全是 0 才算没扫到）', async () => {
    const w = world([item()], { repos: async () => [] });
    expect(await checkGitHubApps(w.deps)).toEqual({ scanned: 0, found: 0, unchecked: [] });
    expect(w.asked).toEqual([]);
  });

  it('缺好几样、也多了：标题一起写', () => {
    expect(
      githubAppAlert(item({ ok: false, missing: ['statuses:write', 'checks:read'], extra: ['issues:write'] }))
        .title,
    ).toBe(
      '「引擎」机器人在 acme/widgets 上的权限不对：缺 statuses:write、checks:read；多了不该有的 issues:write',
    );
  });
});
