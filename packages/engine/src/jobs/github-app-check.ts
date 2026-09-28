// GitHub 两个机器人的权限自检（每小时对账的一项）：@fleet-dao/github 的 selfCheck 写了却从没跑过——权限不够时（比如 App
// 设置里加了 statuses:write、安装处没点接受，second-opinion 就贴不上）没有任何地方报出来。这里每轮对每个受管的仓
// 查一次两个机器人实际拿到的权限，缺的、不该有的、没查成的各报一条「要人看」提醒（键 github-app:<机器人>:<仓>），好了下一轮
// 自己撤；后端健康页的 github_app 项看这些提醒开没开着（同一个前缀 GITHUB_APP_ALERT_PREFIX）。
// 改这里之前必须知道：没查成（没装到这个仓、凭据读不到、GitHub 回的认不出）也报提醒、这一轮记没查全，不当成权限够。
import { GITHUB_APP_ALERT_PREFIX } from '@fleet-dao/db';
import type { RepoRef, SelfCheckItem } from '@fleet-dao/github';
import { type AlertStore, message, RECONCILE_ACTOR, type SweepPart } from './reconcile-common.ts';

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

/** 一条提醒的标题和正文：缺什么、多了什么、没查成的原因；怎么改。 */
export function githubAppAlert(item: SelfCheckItem): { title: string; body: string } {
  const who = ROLE_NAMES[item.role];
  if (item.why) {
    return {
      title: `${who}在 ${item.repo} 上的权限没查成`,
      body: `${item.why}。查成之前按权限不够算：要它做的事（合并、改单、贴 second-opinion……）可能做不成。好了下一轮每小时对账自己撤。`,
    };
  }
  const parts = [
    item.missing.length > 0 ? `缺 ${item.missing.join('、')}` : '',
    item.extra.length > 0 ? `多了不该有的 ${item.extra.join('、')}` : '',
  ].filter(Boolean);
  return {
    title: `${who}在 ${item.repo} 上的权限不对：${parts.join('；')}`,
    body: `去 GitHub 的 App 设置里改，再到装它的地方（Settings → Applications → Installed GitHub Apps → Configure）点接受新权限；改好下一轮每小时对账自己撤。${item.missing.includes('statuses:write') ? '缺 statuses:write 时引擎贴不了 second-opinion，高风险路径的 PR 合并闸会一直等着。' : ''}`,
  };
}

/** 跑一遍：每个仓、每个机器人一条；不对的报（原地更新），对了的撤掉开着的那条。 */
export async function checkGitHubApps(deps: GitHubAppCheckDeps): Promise<SweepPart> {
  let repos: RepoRef[];
  try {
    repos = await deps.apps.repos();
  } catch (err) {
    return {
      failed: `GitHub 机器人权限自检：列受管的仓没成：${message(err)}`,
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
    return { failed: `GitHub 机器人权限自检没跑成：${message(err)}`, scanned: 0, found: 0, unchecked: [] };
  }
  const unchecked: string[] = [];
  let found = 0;
  for (const item of items) {
    const key = githubAppAlertKey(item);
    try {
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
      unchecked.push(`${key} 的提醒没写成：${message(err)}`);
    }
  }
  return { scanned: items.length, found, unchecked };
}
