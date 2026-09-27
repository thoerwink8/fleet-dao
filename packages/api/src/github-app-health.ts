// /healthz 的 github_app 项：GitHub 两个机器人的权限够不够。引擎每小时对账自检一次（engine 的 jobs/github-app-check.ts），
// 缺的、多了不该有的、没查成的各开一条 github-app:* 的提醒；开着就红，权限好了引擎下一轮自己撤、这一项跟着回绿。
// 对外只说一句中性的话（公网看得到：不提仓名、缺哪样权限），提醒的标题只进日志。
import { type Db, GITHUB_APP_ALERT_PREFIX, openAlertsByPrefix } from '@fleet-dao/db';
import { PublicHealthError } from './health.ts';

export function githubAppHealthCheck(db: Db): () => Promise<void> {
  return async () => {
    const open = await openAlertsByPrefix(db, GITHUB_APP_ALERT_PREFIX);
    if (open.length === 0) return;
    throw new PublicHealthError(
      'github_app',
      'GitHub 机器人的权限有要人看的问题',
      open.map((a) => `${a.dedupeKey}：${a.title}`).join('；'),
    );
  };
}
