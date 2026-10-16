// /healthz 的 github_app 项：GitHub 两个机器人的权限够不够。引擎每小时对账自检一次（engine 的 jobs/github-app-check.ts），
// 每个有问题的仓开一条 github-app:<仓>，开着就红，权限好了引擎下一轮自己撤、这一项跟着回绿。
// 对外只说一句中性的话（公网看得到：不提仓名、缺哪样权限），提醒的标题只进日志。
// 分两级，看那条提醒的级别：权限不对、没查成（凭据读不到、GitHub 回的认不出）是真故障，alert 级，红、整体 503；只有「机器人没装到某个仓」
// （这个仓没有别的问题，decision 级，驾驶舱「要你拍的」里有直达链接）是要人去 GitHub 点一下的配置问题，降成警告、不拖垮整体。
// 两类同时有时红的优先。
import { type Db, GITHUB_APP_ALERT_PREFIX, openAlertsByPrefix } from '@fleet-dao/db';
import { PublicHealthError, PublicHealthWarning } from './health.ts';

export function githubAppHealthCheck(db: Db): () => Promise<void> {
  return async () => {
    const open = await openAlertsByPrefix(db, GITHUB_APP_ALERT_PREFIX);
    const broken = open.filter((a) => a.level !== 'decision');
    if (broken.length > 0) {
      throw new PublicHealthError(
        'github_app',
        'GitHub 机器人的权限有要人看的问题',
        broken.map((a) => `${a.dedupeKey}：${a.title}`).join('；'),
      );
    }
    if (open.length === 0) return;
    throw new PublicHealthWarning(
      'github_app_not_installed',
      '有仓还没装好 GitHub 机器人（待处理）',
      open.map((a) => `${a.dedupeKey}：${a.title}`).join('；'),
    );
  };
}
