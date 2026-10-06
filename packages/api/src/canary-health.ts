// /healthz 的 canary 项（健康页写「全流程巡检」，#223）：最近一轮全流程巡检的结论和时间。
// 通过、而且不太旧：好，带一句「最近一轮 09-27 20:26 通过（用时 43 分钟）」；断了、巡检自己没跑成、太久没跑完一轮、
// 一轮都还没跑完：红。「没跑成」和「跑了没问题」分开说（design 第六节「断链怎么被发现」第 5 层）。
// 公网看得到 /healthz：对外只说哪一步、几点，不带仓名、单号和断的原因原文（原因只进日志，细节在卡住报警里）。
// 不在正式环境（FLEET_ENV=production，法国是）的（开发、测试）报「未接」。这一项跟着巡检的结论自己变红，发版脚本只标待处理、不退回
// （deploy/release.sh 的 DRIFTING_HEALTH_ITEMS）。
import {
  CANARY_RUN_TIMEOUT_MINUTES,
  CANARY_STAGE_NAMES,
  type CanaryRunRow,
  type Db,
  latestCanaryRuns,
} from '@fleet-dao/db';
import { PublicHealthError } from './health.ts';

/** 不在正式环境：这一项报「未接」（公网看得到）。 */
export const CANARY_NOT_HERE = '只在正式环境跑';

/** 最近一次通过距今超过这么久，算太久没跑完一轮：6 小时一轮、一轮最长 5 小时，再多给 1 小时。 */
export const CANARY_STALE_MS = 12 * 60 * 60_000;

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** 北京时间「09-27 20:26」。 */
function stamp(at: Date): string {
  const s = new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString();
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`;
}

export type CanaryHealth =
  | { ok: true; note: string }
  | { ok: false; code: string; message: string; detail: string | undefined };

/**
 * 纯判断：最近一轮有结论的、正在跑的那一轮 → 好不好、对外说什么。
 * 还没结论的一轮比最近有结论的那轮开始得早，是早先没收尾的（下一轮开始时补记没跑成），不算在跑；过了一轮工作流的时限
 * 还没结论，工作流已经没了，照实报巡检自己没收尾，不说「在跑」。
 */
export function canaryHealth(
  latest: { finished: CanaryRunRow | null; running: CanaryRunRow | null },
  now: Date,
): CanaryHealth {
  const { finished } = latest;
  const running =
    latest.running && (!finished || latest.running.startedAt.getTime() >= finished.startedAt.getTime())
      ? latest.running
      : null;
  if (running && now.getTime() - running.startedAt.getTime() > CANARY_RUN_TIMEOUT_MINUTES * 60_000) {
    return {
      ok: false,
      code: 'canary_not_run',
      message: `最近一轮（${stamp(running.startedAt)} 开始）过了 ${CANARY_RUN_TIMEOUT_MINUTES / 60} 小时还没有结论：巡检自己没收尾`,
      detail: undefined,
    };
  }
  const inFlight = running ? '；这一轮在跑' : '';
  if (!finished?.endedAt) {
    return {
      ok: false,
      code: 'canary_never',
      message: running ? '第一轮还在跑，还没有结论' : '还没跑完过一轮',
      detail: undefined,
    };
  }
  const when = stamp(finished.endedAt);
  const stage = CANARY_STAGE_NAMES[finished.stage] ?? finished.stage;
  if (finished.verdict === 'broken') {
    return {
      ok: false,
      code: 'canary_broken',
      message: `最近一轮（${when} 有结论）断在「${stage}」${inFlight}`,
      detail: finished.why ?? undefined,
    };
  }
  if (finished.verdict !== 'pass' && finished.verdict !== 'skipped') {
    return {
      ok: false,
      code: 'canary_not_run',
      message: `最近一轮（${when}）巡检自己没跑成${inFlight}`,
      detail: finished.why ?? undefined,
    };
  }
  const age = now.getTime() - finished.endedAt.getTime();
  if (age > CANARY_STALE_MS) {
    const hours = Math.floor(age / (60 * 60_000));
    return {
      ok: false,
      code: 'canary_stale',
      message:
        finished.verdict === 'skipped'
          ? `最近一轮是 ${when} 跳过的，之后 ${hours} 小时没跑完一轮${inFlight}`
          : `最近一次通过是 ${when}，之后 ${hours} 小时没跑完一轮${inFlight}`,
      detail: undefined,
    };
  }
  // 跳过（#1050）：巡检仓的「让 AI 接活」关着，故意不跑；不红（关着是创始人定的状态），但照实说这一轮什么都没验
  if (finished.verdict === 'skipped') {
    return { ok: true, note: `最近一轮 ${when} 跳过：巡检仓的「让 AI 接活」关着，没开单、没验${inFlight}` };
  }
  const minutes = Math.max(
    1,
    Math.round((finished.endedAt.getTime() - finished.startedAt.getTime()) / 60_000),
  );
  return { ok: true, note: `最近一轮 ${when} 通过（用时 ${minutes} 分钟）${inFlight}` };
}

/** 健康检查：现读库里最近的两轮；读不到照抛（报「连不上」，不当成没问题）。好的时候带一句说明。 */
export function canaryHealthCheck(db: Db, now: () => Date = () => new Date()): () => Promise<string> {
  return async () => {
    const got = canaryHealth(await latestCanaryRuns(db), now());
    if (!got.ok) throw new PublicHealthError(got.code, got.message, got.detail);
    return got.note;
  };
}
