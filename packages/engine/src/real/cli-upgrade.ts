// 命令行工具升级的真接线（#1971）：空闲时排空、写请求文件，下一轮看 root 单元写回的结果、撤排空、该报警的报警。
// 引擎用户没有 root，这里不装任何东西。
import {
  type Db,
  finishScheduleRun,
  intakeFoundSince,
  resolveAlertWithReason,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import { CLI_UPGRADE_DIR } from '../cli-upgrade.ts';
import {
  clearUpgradePending,
  quarantineUpgradeRequest,
  readUpgradePendingAt,
  readUpgradeStateFile,
  writeUpgradeRequest,
} from '../cli-upgrade-files.ts';
import type { EngineDrain } from '../drain.ts';
import type { EngineMasterGate } from '../engine-master.ts';
import type { CliUpgradeJobDeps } from '../jobs/cli-upgrade.ts';

const ACTOR = 'engine:cli-upgrade';

export interface CliUpgradeWiring {
  db: Db;
  drain?: EngineDrain;
  master: EngineMasterGate;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  log?: CliUpgradeJobDeps['log'];
}

/** 给 EngineJobs.cliUpgrade 用的工厂。 */
export function cliUpgradeJob(w: CliUpgradeWiring): () => CliUpgradeJobDeps {
  const now = w.now ?? (() => new Date());
  const log: CliUpgradeJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const dir = w.env?.FLEET_CLI_UPGRADE_DIR || CLI_UPGRADE_DIR;
  return () => ({
    now,
    inFlight: () => w.drain?.inFlight().length ?? 0,
    masterOn: () => w.master.isOn(),
    intakeFound: (since) => intakeFoundSince(w.db, since),
    stopping: () => {
      const c = w.drain?.stopping();
      return c ? { source: c.source, since: c.since } : null;
    },
    cordon(input) {
      if (!w.drain) return false;
      w.drain.cordon({ source: 'cli-upgrade', since: input.since, until: input.until, why: input.why });
      return w.drain.stopping()?.source === 'cli-upgrade';
    },
    lift: () => {
      w.drain?.lift('cli-upgrade');
    },
    readState: () => readUpgradeStateFile(dir),
    pendingAt: () => readUpgradePendingAt(dir),
    writeRequest: (input) => writeUpgradeRequest(dir, input.at),
    quarantine: () => quarantineUpgradeRequest(dir),
    clearPending: () => clearUpgradePending(dir),
    raise: (alert) =>
      upsertAlert(w.db, {
        dedupeKey: alert.key,
        level: 'alert',
        taskId: null,
        title: alert.title,
        body: alert.body,
        link: '/france',
      }).then(() => undefined),
    resolve: (key) =>
      resolveAlertWithReason(w.db, {
        dedupeKey: key,
        by: ACTOR,
        why: '这一条已经不成立了',
        at: now(),
      }).then(() => undefined),
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    log,
  });
}
