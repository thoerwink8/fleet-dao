// 空闲时升级命令行工具（#1971）：引擎自己没有 root，只在空闲时排空并写一份请求，root 的单元去装。
// 不在这一轮里等 npm：写下请求就返回，下一轮看结果、撤排空、该报警的报警。
// 改这里之前必须知道：
// - 总开关关着也要跑（拉单停的时候正是空闲）。不标 needsMaster。
// - 有会话、这一小时拉单还有候选、发布正在排空：什么都不写。
// - 工具上一次失败还记着：不再写请求。提醒每一轮都推一次（同一条，不另起一条）。
// - 请求写下 45 分钟还没有结果：撤排空、把请求改名，免得单元晚到、在会话已经起来之后才换二进制。这种不算工具失败，下一轮空闲再试。

import type { ScheduleResult } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { decide, type TickInput, type UpgradeState } from '../cli-upgrade.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';

export const CLI_UPGRADE_EVERY_MINUTES = 30;
/** 和每小时对账（41 分）、判断题自检（17 分）、拉单（3 分）错开。 */
export const CLI_UPGRADE_OFFSET_MINUTES = 6;

export const CLI_UPGRADE_JOB = {
  id: 'cli-upgrade',
  name: '命令行工具升级',
  schedule: '每 30 分钟（6 分起）',
  // 连着三轮没跑成才算过期。
  expectEveryMinutes: 90,
} as const;

export const alertKey = (id: string) => `cli-upgrade:${id}`;
export const STUCK_ALERT_KEY = 'cli-upgrade:stuck';
export const DIR_ALERT_KEY = 'cli-upgrade:dir';

export interface CliUpgradeJobDeps {
  now(): Date;
  inFlight(): number;
  masterOn(): boolean;
  intakeFound(since: Date): Promise<(number | null)[]>;
  stopping(): { source: string; since: string } | null;
  /** 挂上升级排空。返回 false 就是没挂上（发布或停机已经占着）。 */
  cordon(input: { since: string; until: string; why: string }): boolean;
  lift(): void;
  readState(): Promise<UpgradeState | null>;
  /** wanted.json 里这一次的 at。没有就是 null。 */
  pendingAt(): Promise<string | null>;
  writeRequest(input: { at: string }): Promise<void>;
  /** 单元没来：把请求改名，再删掉 wanted。文件本来没有就不算错。 */
  quarantine(): Promise<void>;
  /** 这一轮做完：删掉 wanted 和还留着的请求。 */
  clearPending(): Promise<void>;
  raise(alert: { key: string; title: string; body: string }): Promise<void>;
  resolve(key: string): Promise<void>;
  runs: ScheduleRunLog;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

async function syncAlerts(
  deps: CliUpgradeJobDeps,
  state: UpgradeState | null,
  stuck: boolean,
): Promise<void> {
  if (state) {
    for (const [id, tool] of Object.entries(state.tools)) {
      if (tool.failure) {
        await deps.raise({
          key: alertKey(id),
          title: `${tool.name} 升级没成`,
          body: `${tool.detail}。不再自动重试。看完以后，删掉 /var/lib/fleet-dao/cli-upgrade/state.json 里这个工具的 failure 才再升。`,
        });
      } else {
        await deps.resolve(alertKey(id));
      }
    }
  }
  if (stuck) {
    await deps.raise({
      key: STUCK_ALERT_KEY,
      title: '命令行工具升级没有做完',
      body: '请求写下 45 分钟，root 的升级单元还没有写回结果。排空已经撤掉，二进制不一定动过。看 journalctl -u fleet-cli-upgrade。下一轮空闲会再试。',
    });
  } else {
    await deps.resolve(STUCK_ALERT_KEY);
  }
}

function resultOf(decision: { kind: string; why?: string }, failed: number): ScheduleResult {
  if (decision.kind === 'stuck' || failed > 0) {
    const why =
      decision.kind === 'stuck' ? '升级单元没有在时限内写回结果' : `${failed} 个工具升级没成，不再重试`;
    return { outcome: 'partial', why, scanned: 1, found: failed };
  }
  return { outcome: 'ok', scanned: 1, found: 0, ...(decision.why ? { why: decision.why } : {}) };
}

/** 跑一轮。记开始就失败（库连不上）原样抛出。写请求失败记 failed 再抛。 */
export async function runCliUpgradeJob(deps: CliUpgradeJobDeps): Promise<void> {
  const started = deps.now();
  const runId = await deps.runs.start(CLI_UPGRADE_JOB.id, started);
  let result: ScheduleResult;
  try {
    const state = await deps.readState();
    const pendingAt = await deps.pendingAt();
    const since = new Date(started.getTime() - 60 * 60_000);
    const input: TickInput = {
      now: started,
      inFlight: deps.inFlight(),
      masterOn: deps.masterOn(),
      intakeFound: await deps.intakeFound(since),
      cordon: deps.stopping(),
      pendingAt,
      state,
    };
    const decision = decide(input);
    const failed = state ? Object.values(state.tools).filter((tool) => tool.failure).length : 0;
    if (decision.kind === 'request') {
      const held = deps.cordon({ since: decision.at, until: decision.until, why: '空闲，升级命令行工具' });
      if (!held && deps.stopping()?.source !== 'cli-upgrade') {
        result = { outcome: 'ok', scanned: 1, found: 0, why: '刚要排空时发布或停机接走了，这轮不写请求' };
      } else {
        await deps.writeRequest({ at: decision.at });
        await deps.resolve(DIR_ALERT_KEY);
        result = { outcome: 'ok', scanned: 1, found: 0, why: '已写升级请求' };
      }
    } else if (decision.kind === 'finish') {
      deps.lift();
      await deps.clearPending();
      result = resultOf(decision, failed);
    } else if (decision.kind === 'stuck') {
      deps.lift();
      await deps.quarantine();
      result = resultOf(decision, failed);
    } else {
      result = resultOf(decision, failed);
    }
    await syncAlerts(deps, state, decision.kind === 'stuck');
  } catch (err) {
    const why = `命令行工具升级这轮没跑成：${errMessage(err)}`;
    result = { outcome: 'failed', why };
    await deps
      .raise({ key: DIR_ALERT_KEY, title: '命令行工具升级没跑成', body: why })
      .catch((alertErr: unknown) =>
        deps.log('error', '升级失败的提醒没写进去', { error: errMessage(alertErr) }),
      );
  }
  await deps.runs.finish(runId, result, deps.now());
  deps.log(result.outcome === 'failed' ? 'error' : 'info', '命令行工具升级这一轮', {
    outcome: result.outcome,
    why: 'why' in result ? result.why : undefined,
  });
  if (result.outcome === 'failed') throw new Error(result.why);
}
