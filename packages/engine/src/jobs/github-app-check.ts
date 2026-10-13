// GitHub 两个机器人的权限自检（每小时对账的一项）：@fleet-dao/github 的 selfCheck 写了却从没跑过——权限不够时（比如 App
// 设置里加了 statuses:write、安装处没点接受，#299 的「认领对得上」就贴不上）没有任何地方报出来。这里每轮对每个受管的仓
// 查一次两个机器人实际拿到的权限，缺的、不该有的、没查成的各报一条「要人看」提醒（键 github-app:<机器人>:<仓>），好了下一轮
// 自己撤；后端健康页的 github_app 项看这些提醒开没开着（同一个前缀 GITHUB_APP_ALERT_PREFIX）。
// 改这里之前必须知道：没查成（没装到这个仓、凭据读不到、GitHub 回的认不出）也报提醒、这一轮记没查全，不当成权限够。

import { GITHUB_APP_ALERT_PREFIX } from '@fleet-dao/db';
import type { RepoRef, SelfCheckItem } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { type AlertStore, RECONCILE_ACTOR, type SweepPart } from './reconcile-common.ts';

export interface GitHubAppCheckDeps {
  apps: {
    /** 受管的仓（库里的 repos 表）。 */
    repos(): Promise<RepoRef[]>;
    /** 两个机器人在这些仓上的安装实际拿到的权限够不够（真实现是 @fleet-dao/github 的 GitHub.selfCheck）。 */
    selfCheck(repos: RepoRef[]): Promise<SelfCheckItem[]>;
  };
  alerts: Pick<AlertStore, 'byKey' | 'raise' | 'resolve' | 'openByPrefix'>;
}

const ROLE_NAMES: Record<SelfCheckItem['role'], string> = {
  agent: '「干活的」机器人',
  engine: '「引擎」机器人',
};

export const githubAppAlertKey = (item: Pick<SelfCheckItem, 'role' | 'repo'>) =>
  `${GITHUB_APP_ALERT_PREFIX}${item.role}:${item.repo}`;

/**
 * 撤销提醒时按前缀找出「这一轮已经不看它了」的那些：仓从 repos 表里移出去了（人移出驾驶舱、别的对账删的行），
 * 它那条 github-app:* 再也轮不到（每一轮只按这一轮自检过的 key 撤），会永远开着、后端 /healthz 的 github_app 一直红。
 * 键的形状是 github-app:<机器人>:<owner/repo>，仓名里的 / 不是分隔符，所以从右边认：agent|engine 在前、仓在后。
 */
function githubAppAlertRepo(dedupeKey: string): { role: 'agent' | 'engine'; repo: string } | null {
  for (const role of ['engine', 'agent'] as const) {
    const head = `${GITHUB_APP_ALERT_PREFIX}${role}:`;
    if (dedupeKey.startsWith(head)) return { role, repo: dedupeKey.slice(head.length) };
  }
  return null;
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

/** 跑一遍：每个仓、每个机器人一条；不对的报（原地更新），对了的撤掉开着的那条；不受管的仓留下的旧提醒也撤掉。 */
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
  let items: SelfCheckItem[];
  if (repos.length === 0) {
    // 一个受管的仓都没有：没有要自检的，但前面那些仓留下的旧提醒得按下面的「不受管就撤」清掉。
    items = [];
  } else {
    try {
      items = await deps.apps.selfCheck(repos);
    } catch (err) {
      return {
        failed: `GitHub 机器人权限自检没跑成：${errMessage(err)}`,
        scanned: 0,
        found: 0,
        unchecked: [],
      };
    }
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
      unchecked.push(`${key} 的提醒没写成：${errMessage(err)}`);
    }
  }
  // 这一轮自检过的键；还开着的 github-app:* 里不在这一份里的，说明那个仓已经不受管了（移出驾驶舱、别的对账删的行）：
  // 它再也不会被自检到、也就永远轮不到上面那段撤，撤掉它，别让后端 /healthz 的 github_app 为它一直红（#2023）。
  const known = new Set(items.map((item) => githubAppAlertKey(item)));
  try {
    for (const alert of await deps.alerts.openByPrefix(GITHUB_APP_ALERT_PREFIX)) {
      if (known.has(alert.dedupeKey)) continue;
      const where = githubAppAlertRepo(alert.dedupeKey);
      const done = await deps.alerts.resolve({
        dedupeKey: alert.dedupeKey,
        by: RECONCILE_ACTOR,
        why: where
          ? `${where.repo} 已经不在受管的仓里了（${ROLE_NAMES[where.role]}的权限自检不再看它）`
          : '这条权限提醒对应的仓已经不在受管的仓里了（权限自检不再看它）',
      });
      if (done === 'ok') found += 1;
    }
  } catch (err) {
    unchecked.push(`撤不受管的机器人权限提醒没成：${errMessage(err)}`);
  }
  return { scanned: items.length, found, unchecked };
}
