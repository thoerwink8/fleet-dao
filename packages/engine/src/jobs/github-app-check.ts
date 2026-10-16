// GitHub 两个机器人的权限自检（每小时对账的一项）：@fleet-dao/github 的 selfCheck 写了却从没跑过——权限不够时（比如 App
// 设置里加了 statuses:write、安装处没点接受，#299 的「认领对得上」就贴不上）没有任何地方报出来。这里每轮对每个受管的仓
// 查一次两个机器人实际拿到的权限，缺的、不该有的、没查成的各报一条「要人看」提醒（键 github-app:<机器人>:<仓>），好了下一轮
// 自己撤；后端健康页的 github_app 项看这些提醒开没开着（同一个前缀 GITHUB_APP_ALERT_PREFIX）。
// 改这里之前必须知道：没查成（凭据读不到、GitHub 回的认不出）也报提醒、这一轮记没查全，不当成权限够。
// 唯一的例外是「机器人没装到这个仓」（SelfCheckItem.notInstalled，多半是刚导入新仓还没去 GitHub 装）：那是要人去点一下的配置问题，
// 不是权限故障，改成每个仓一条「要你拍的」（github-app-missing:<仓>，带 GitHub 直达链接），后端健康页只报警告、不 503；
// 装好了下一轮自己撤。别把别的没查成也塞进这一类。

import { GITHUB_APP_ALERT_PREFIX, GITHUB_APP_MISSING_ALERT_PREFIX } from '@fleet-dao/db';
import type { RepoRef, SelfCheckItem } from '@fleet-dao/github';
import { APPS_NOT_INSTALLED_HINT, type DecisionOption, githubInstallLinks } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { type AlertStore, RECONCILE_ACTOR, type SweepPart } from './reconcile-common.ts';

export interface GitHubAppCheckDeps {
  apps: {
    /** 受管的仓（库里的 repos 表）。 */
    repos(): Promise<RepoRef[]>;
    /** 两个机器人在这些仓上的安装实际拿到的权限够不够（真实现是 @fleet-dao/github 的 GitHub.selfCheck）。 */
    selfCheck(repos: RepoRef[]): Promise<SelfCheckItem[]>;
  };
  alerts: Pick<AlertStore, 'byKey' | 'raise' | 'resolve'>;
}

const ROLE_NAMES: Record<SelfCheckItem['role'], string> = {
  agent: '「干活的」机器人',
  engine: '「引擎」机器人',
};

export const githubAppAlertKey = (item: Pick<SelfCheckItem, 'role' | 'repo'>) =>
  `${GITHUB_APP_ALERT_PREFIX}${item.role}:${item.repo}`;

export const githubAppMissingAlertKey = (repo: string) => `${GITHUB_APP_MISSING_ALERT_PREFIX}${repo}`;

/** 一小时里最多往 why 里写几个仓名（够人看一眼，不刷屏）。 */
const SKIP_NAMES_MAX = 3;

/**
 * 已知「机器人没装到这个仓」的仓：库里有这个仓开着的 github-app-missing 提醒。那条提醒只有安装核对明确判为没装
 * （SelfCheckItem.notInstalled）才会报，装好了会自己撤；所以对账/轮询可以放心跳过它们、不记没跑全。
 * 只认这一种：凭据读不到、GitHub 回错都不在里面，照旧记没查成。列提醒读不出来就抛——调用方当「没有已知没装的仓」，一个都不跳。
 */
export async function reposKnownNotInstalled(
  repos: readonly { owner: string; name: string }[],
  byKey: (dedupeKey: string) => Promise<{ resolvedAt: Date | null } | null>,
): Promise<Set<string>> {
  const skipped = new Set<string>();
  for (const r of repos) {
    const slug = `${r.owner}/${r.name}`;
    const alert = await byKey(githubAppMissingAlertKey(slug));
    if (alert && alert.resolvedAt === null) skipped.add(slug);
  }
  return skipped;
}

/** 写进 why 的一句：跳过了几个没装机器人的仓。 */
export function skippedReposNote(slugs: readonly string[]): string {
  const shown = slugs.slice(0, SKIP_NAMES_MAX).join('、');
  const more = slugs.length > SKIP_NAMES_MAX ? ' 等' : '';
  return `跳过 ${slugs.length} 个没装机器人的仓（已有提醒）：${shown}${more}`;
}

/** 「没装到这个仓」那条要你拍的：说明白先去 GitHub 装、直达链接写进正文，点开去设置页（那里也有链接）。 */
export function githubAppMissingAlert(
  repo: string,
  roles: readonly SelfCheckItem['role'][],
): { title: string; body: string; link: string } {
  const names = roles.map((r) => ROLE_NAMES[r]).join('、');
  const links = githubInstallLinks({ owner: repo.split('/')[0] ?? repo, missing: roles });
  return {
    title: `${repo}：${APPS_NOT_INSTALLED_HINT}（还没装：${names}）`,
    body: [
      `${repo} 已经导入驾驶舱，但 ${names}还没装到这个仓，要它们做的事（合并、改单、贴状态……）做不成。`,
      `${APPS_NOT_INSTALLED_HINT}：点下面的链接，选 Only select repositories、只勾这个仓。`,
      ...links.map((l) => `${l.label}：${l.url}`),
      '装好后下一轮每小时对账自己撤。',
    ].join('\n'),
    link: '/settings',
  };
}

/** 「没装到这个仓」的两个选项：再查一次（推荐），或者把这个仓移出驾驶舱。 */
export function githubAppMissingOptions(repo: string): DecisionOption[] {
  const slash = repo.indexOf('/');
  const owner = slash > 0 ? repo.slice(0, slash) : '';
  const name = slash > 0 ? repo.slice(slash + 1) : '';
  return [
    {
      id: 'recheck',
      label: '我装好了，再查一次',
      detail: `再查 ${repo} 上两个机器人装了没有；都装上了这条才转已处理`,
      recommended: '装好再查，不用把仓移出驾驶舱',
      action: { kind: 'recheck', what: 'github-app', repo },
    },
    {
      id: 'drop',
      label: '这个仓先不监控',
      detail: name
        ? `把 ${repo} 移出驾驶舱的受管仓；上面还有没做完的单就移不走，这条留着并写明原因`
        : `仓名认不出（${repo}），这条记下交给指挥官`,
      action: name ? { kind: 'drop-repo', owner, name } : { kind: 'note-only' },
    },
  ];
}

/** 一条提醒的标题和正文：缺什么、多了什么、没查成的原因；怎么改。 */
export function githubAppAlert(item: SelfCheckItem): { title: string; body: string } {
  const who = ROLE_NAMES[item.role];
  if (item.why) {
    return {
      title: `${who}在 ${item.repo} 上的权限没查成`,
      body: `${item.why}。查成之前按权限不够算：要它做的事（合并、改单、贴「认领对得上」……）可能做不成。好了下一轮每小时对账自己撤。`,
    };
  }
  const parts = [
    item.missing.length > 0 ? `缺 ${item.missing.join('、')}` : '',
    item.extra.length > 0 ? `多了不该有的 ${item.extra.join('、')}` : '',
  ].filter(Boolean);
  return {
    title: `${who}在 ${item.repo} 上的权限不对：${parts.join('；')}`,
    body: `去 GitHub 的 App 设置里改，再到装它的地方（Settings → Applications → Installed GitHub Apps → Configure）点接受新权限；改好下一轮每小时对账自己撤。${item.missing.includes('statuses:write') ? '缺 statuses:write 时引擎贴不了 cold-verify（引擎 PR 的合并闸会一直等着）和「认领对得上」（#299）。' : ''}`,
  };
}

/** 跑一遍：每个仓、每个机器人一条；不对的报（原地更新），对了的撤掉开着的那条。 */
export async function checkGitHubApps(deps: GitHubAppCheckDeps): Promise<SweepPart> {
  let repos: RepoRef[];
  try {
    repos = await deps.apps.repos();
  } catch (err) {
    return {
      failed: `GitHub 机器人权限自检：列受管的仓没成：${errMessage(err)}`,
      scanned: 0,
      found: 0,
      unchecked: [],
    };
  }
  if (repos.length === 0) return { scanned: 0, found: 0, unchecked: [] };
  let items: SelfCheckItem[];
  try {
    items = await deps.apps.selfCheck(repos);
  } catch (err) {
    return { failed: `GitHub 机器人权限自检没跑成：${errMessage(err)}`, scanned: 0, found: 0, unchecked: [] };
  }
  const unchecked: string[] = [];
  let found = 0;
  // 没装到的单独成一类（每个仓一条），其余照旧
  const missingByRepo = new Map<string, SelfCheckItem['role'][]>();
  for (const item of items) {
    if (item.notInstalled && !item.ok) {
      missingByRepo.set(item.repo, [...(missingByRepo.get(item.repo) ?? []), item.role]);
    }
  }
  for (const item of items) {
    const key = githubAppAlertKey(item);
    try {
      if (item.notInstalled && !item.ok) {
        // 以前把它当权限故障报过的老提醒撤掉，不然健康页还红
        const old = await deps.alerts.byKey(key);
        if (old && old.resolvedAt === null) {
          await deps.alerts.resolve({
            dedupeKey: key,
            by: RECONCILE_ACTOR,
            why: `${item.repo} 没装机器人改成每个仓一条「要你拍的」报（${githubAppMissingAlertKey(item.repo)}）`,
          });
        }
        continue;
      }
      if (item.ok && item.extra.length === 0) {
        const open = await deps.alerts.byKey(key);
        if (open && open.resolvedAt === null) {
          await deps.alerts.resolve({
            dedupeKey: key,
            by: RECONCILE_ACTOR,
            why: `${ROLE_NAMES[item.role]}在 ${item.repo} 上的权限够了（每小时对账自检读回）`,
          });
          found += 1;
        }
        continue;
      }
      // item.why 开头已经写了是哪个机器人
      if (item.why) unchecked.push(`${item.repo}：${item.why}`);
      await deps.alerts.raise({ dedupeKey: key, level: 'alert', taskId: null, ...githubAppAlert(item) });
      found += 1;
    } catch (err) {
      unchecked.push(`${key} 的提醒没写成：${errMessage(err)}`);
    }
  }
  const repoNames = new Set(items.map((i) => i.repo));
  for (const repo of repoNames) {
    const key = githubAppMissingAlertKey(repo);
    const roles = missingByRepo.get(repo);
    try {
      if (roles) {
        await deps.alerts.raise({
          dedupeKey: key,
          level: 'decision',
          taskId: null,
          ...githubAppMissingAlert(repo, roles),
          options: githubAppMissingOptions(repo),
        });
        found += 1;
        continue;
      }
      const open = await deps.alerts.byKey(key);
      if (open && open.resolvedAt === null) {
        await deps.alerts.resolve({
          dedupeKey: key,
          by: RECONCILE_ACTOR,
          why: `${repo} 的两个机器人都装上了（每小时对账自检读回）`,
        });
        found += 1;
      }
    } catch (err) {
      unchecked.push(`${key} 的提醒没写成：${errMessage(err)}`);
    }
  }
  return { scanned: items.length, found, unchecked };
}
