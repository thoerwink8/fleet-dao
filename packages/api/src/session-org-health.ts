// /healthz 的 session_org 项：会话用户切号（#157）有没有要人看的。引擎切号没成、切完探针读回不在线、拼车用满却读不到几点
// 恢复，都写一条 session-org:* 的提醒（engine 的 real/org-switch.ts）；开着就红，条件没了引擎自己撤、这一项跟着回绿。
// 对外只说一句中性的话（公网看得到：不提组织、拼车独享这些），提醒的标题只进日志。
import { type Db, openAlertsByPrefix, SESSION_ORG_ALERT_PREFIX } from '@fleet-dao/db';
import { PublicHealthError } from './health.ts';

export function sessionOrgHealthCheck(db: Db): () => Promise<void> {
  return async () => {
    const open = await openAlertsByPrefix(db, SESSION_ORG_ALERT_PREFIX);
    if (open.length === 0) return;
    throw new PublicHealthError(
      'session_org',
      '会话账号切换有要人看的问题',
      open.map((a) => `${a.dedupeKey}：${a.title}`).join('；'),
    );
  };
}
