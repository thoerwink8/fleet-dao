// 提醒派单的真装配（design 15.3「谁在处理」）：提醒、跟进单、认领、PR 镜像、静默、设置都是同一个库（@fleet-dao/db）；
// 谁在处理的事实和驾驶舱、fleet-api alert 读的是同一个口子（@fleet-dao/api 的 pgAlertWork），判法只 core 那一份；
// 发布记录读法国的（current 链接和自动发布的状态文件，和健康页 deploy_lag 同一份）；开跟进单、读里程碑是「引擎」机器人。
import { deployFacts, pgAlertWork, readDeployLagInput } from '@fleet-dao/api';
import { type DeployFacts, readAlertSettings } from '@fleet-dao/core';
import {
  alertByKey,
  type Db,
  finishScheduleRun,
  linkAlertWork,
  listFlowReplicas,
  listOpenAlerts,
  readAlertSettingRaw,
  resolveAlertWithReason,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import { ALERT_DISPATCH_ACTOR, type AlertDispatchDeps } from '../jobs/alert-dispatch.ts';

export interface AlertDispatchWiring {
  db: Db;
  gh: Pick<GitHub, 'openIssue' | 'readOpenMilestones'>;
  /** 巡检仓（引擎配置 FLEET_CANARY_REPO）：跟进单不开在那儿。 */
  canaryRepo: string | undefined;
  /** 测试用：发布记录（不给就读法国的 current 链接和自动发布的状态文件）。 */
  deploy?: () => DeployFacts | null;
  now?: () => Date;
  log?: AlertDispatchDeps['log'];
}

/** 给 EngineJobs.alertDispatch 用的工厂。 */
export function alertDispatchJob(w: AlertDispatchWiring): () => AlertDispatchDeps {
  const now = w.now ?? (() => new Date());
  const log: AlertDispatchDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const port = pgAlertWork(w.db, w.deploy ?? (() => deployFacts(readDeployLagInput())));
  return () => ({
    settings: async () => readAlertSettings(await readAlertSettingRaw(w.db)),
    listOpen: (limit) => listOpenAlerts(w.db, { limit }),
    read: (ids) => port.read(ids),
    deploy: () => port.deploy(),
    alerts: {
      byKey: (key) => alertByKey(w.db, key),
      async raise(x) {
        await upsertAlert(w.db, {
          dedupeKey: x.dedupeKey,
          level: x.level,
          taskId: x.taskId,
          title: x.title,
          body: x.body,
          ...(x.link ? { link: x.link } : {}),
        });
      },
      resolve: (x) =>
        resolveAlertWithReason(w.db, {
          dedupeKey: x.dedupeKey,
          by: ALERT_DISPATCH_ACTOR,
          why: x.why,
          at: now(),
        }),
    },
    issues: {
      repos: async () =>
        (await listFlowReplicas(w.db)).map((r) => ({ id: r.repoId, owner: r.owner, name: r.name })),
      canaryRepo: w.canaryRepo?.trim() || null,
      openMilestones: (repo) => w.gh.readOpenMilestones({ repo }),
      open: (input) => w.gh.openIssue(input),
      async link(x) {
        const r = await linkAlertWork(w.db, {
          notificationId: x.notificationId,
          repoId: x.repoId,
          issueNumber: x.issueNumber,
          source: 'engine',
          linkedBy: ALERT_DISPATCH_ACTOR,
          note: x.note,
          mode: 'if_absent',
          audit: { actorKind: 'engine', actorId: ALERT_DISPATCH_ACTOR, via: 'engine' },
        });
        return r.result;
      },
    },
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
