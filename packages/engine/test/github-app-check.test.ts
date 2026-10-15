// 每小时对账的第三项：GitHub 两个机器人的权限自检（jobs/github-app-check.ts）。缺权限、多了不该有的、没查成、列不了仓、
// 自检整个没跑成，各故意造一次：都报出来（提醒或这一轮没查全），不许当成权限够；权限好了下一轮自己撤。
import { type AlertRow, GITHUB_APP_ALERT_PREFIX, GITHUB_APP_MISSING_ALERT_PREFIX } from '@fleet-dao/db';
import type { RepoRef, SelfCheckItem } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import {
  checkGitHubApps,
  type GitHubAppCheckDeps,
  githubAppAlert,
  githubAppAlertKey,
  githubAppMissingAlertKey,
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
  raisedAt: new Date('2026-09-27T10:00:00.000Z'),
  updatedAt: new Date('2026-09-27T10:00:00.000Z'),
  resolvedAt: null,
  resolvedBy: null,
});

interface World {
  deps: GitHubAppCheckDeps;
  raised: { dedupeKey: string; level: string; title: string; body: string; link?: string | undefined }[];
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
        raised.push({
          dedupeKey: input.dedupeKey,
          level: input.level,
          title: input.title,
          body: input.body,
          link: input.link,
        });
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
      '「引擎」机器人没查成：「引擎」机器人没装到 acme/widgets（或这个仓不存在）：到 App 设置页把它装到这个仓（只勾这个仓即可；仓在别的账号或组织下时，App 要先在设置的 Advanced 里设成公开，私有的只能装在建它的账号下）';
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

  describe('机器人没装到某个仓（刚导入新仓）：降成要你拍的，不当权限故障', () => {
    const notInstalled = (role: SelfCheckItem['role']) =>
      item({ role, ok: false, notInstalled: true, why: `没装到 acme/widgets（${role}）` });

    it('两个都没装：每个仓只报一条要你拍的，正文有两个 App 的安装页和 GitHub 设置页直达链接', async () => {
      const w = world([notInstalled('agent'), notInstalled('engine')]);
      const part = await checkGitHubApps(w.deps);
      // 已经按要人拍的报出来了，不再记「没查全」
      expect(part).toEqual({ scanned: 2, found: 1, unchecked: [] });
      expect(w.raised).toHaveLength(1);
      expect(w.raised[0]).toMatchObject({
        dedupeKey: 'github-app-missing:acme/widgets',
        level: 'decision',
        link: '/settings',
      });
      expect(w.raised[0]?.title).toContain('先去 GitHub 把两个机器人装到这个仓');
      const body = w.raised[0]?.body ?? '';
      expect(body).toContain('https://github.com/apps/fleet-dao-agent/installations/new');
      expect(body).toContain('https://github.com/apps/fleet-dao-engine/installations/new');
      expect(body).toContain('https://github.com/settings/installations');
      expect(githubAppMissingAlertKey('acme/widgets')).toBe(`${GITHUB_APP_MISSING_ALERT_PREFIX}acme/widgets`);
      // 不与权限故障共用前缀（健康页按前缀分级）
      expect(githubAppMissingAlertKey('acme/widgets').startsWith(GITHUB_APP_ALERT_PREFIX)).toBe(false);
    });

    it('只缺一个：正文只写缺的那个的安装页', async () => {
      const w = world([item({ role: 'agent' }), notInstalled('engine')]);
      await checkGitHubApps(w.deps);
      const body = w.raised[0]?.body ?? '';
      expect(body).toContain('fleet-dao-engine/installations/new');
      expect(body).not.toContain('fleet-dao-agent/installations/new');
    });

    it('以前当权限故障报过的老提醒：撤掉，不然健康页还红', async () => {
      const w = world([notInstalled('agent'), notInstalled('engine')], {
        open: ['github-app:agent:acme/widgets'],
      });
      await checkGitHubApps(w.deps);
      expect(w.resolved.map((r) => r.dedupeKey)).toEqual(['github-app:agent:acme/widgets']);
    });

    it('【不降级】一个没装、另一个权限缺：权限那条照旧是 alert 级', async () => {
      const w = world([
        item({ role: 'agent', ok: false, missing: ['statuses:write'] }),
        notInstalled('engine'),
      ]);
      await checkGitHubApps(w.deps);
      const keys = w.raised.map((r) => `${r.level} ${r.dedupeKey}`);
      expect(keys).toContain('alert github-app:agent:acme/widgets');
      expect(keys).toContain('decision github-app-missing:acme/widgets');
    });

    it('【不降级】没查成但不是「没装」（凭据读不到、GitHub 回的认不出）：仍是权限故障 alert，记没查全', async () => {
      const w = world([
        item({ role: 'agent' }),
        item({ ok: false, why: '「引擎」机器人没查成：凭据读不到' }),
      ]);
      const part = await checkGitHubApps(w.deps);
      expect(part.unchecked).toHaveLength(1);
      expect(w.raised.map((r) => `${r.level} ${r.dedupeKey}`)).toEqual([
        'alert github-app:engine:acme/widgets',
      ]);
    });

    it('装好了：开着的 github-app-missing 自己撤；没开着的不去撤', async () => {
      const w = world([item({ role: 'agent' }), item()], { open: ['github-app-missing:acme/widgets'] });
      const part = await checkGitHubApps(w.deps);
      expect(part).toEqual({ scanned: 2, found: 1, unchecked: [] });
      expect(w.resolved).toEqual([
        {
          dedupeKey: 'github-app-missing:acme/widgets',
          by: RECONCILE_ACTOR,
          why: 'acme/widgets 的两个机器人都装上了（每小时对账自检读回）',
        },
      ]);
      const quiet = world([item({ role: 'agent' }), item()]);
      await checkGitHubApps(quiet.deps);
      expect(quiet.resolved).toEqual([]);
    });
  });
});
