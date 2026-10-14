// /healthz 的 canary 项（健康页写「全流程巡检」，#223）：最近一轮全流程巡检的结论和时间。
// 通过、而且不太旧：好，带一句「最近一轮 09-27 20:26 通过（用时 43 分钟）」；断了、巡检自己没跑成、太久没跑完一轮、
// 一轮都还没跑完：红。「没跑成」和「跑了没问题」分开说（design 第六节「断链怎么被发现」第 5 层）。
// 公网看得到 /healthz：对外只说哪一步、几点，不带仓名、单号和断的原因原文（原因只进日志，细节在卡住报警里）。
// 引擎总开关关着时（#1086）巡检的定时任务整个不跑（jobs/timers.ts 的 needsMaster 闸）、连跳过的轮次都不写 canary_runs，
// 这一项认得出「总开关关着＝跳过」：照实说跳过、回待定、不拿断了的旧结论报 canary_broken、也不当通过（#1141 / #1808）。
// 发版那一趟会先暂停总开关、发完再开回（决定 0032）。暂停的那几分钟如果只写「总开关关着」，监督会当成新的断链重复开单
// （#1859、#2084）。读得到发版进度时：进行中写明「按这一趟暂停，发完开回」；发前开着、这一趟已经该开回却还关着，改报红。
// 最近一轮结论早于当前部署（引擎进程起来的时刻）时同样回待定，写明等新一轮——发版装上修复后不再拿修复前的断结论报红（#1808）。
// 最近一轮是「跳过」也回待定、不当通过（发版期间跳过曾被误判成修好，#1773 / #1808）。
// 待定不当红、也不让 /healthz 变 503（#1909）：它照样抛，但抛的是 PublicHealthPending（health.ts）——健康页画成「待定」
// 等着，不再是「断了」那种 503。发版后「结论早于当前部署」是预期窗口，发完版到下一轮巡检出结论之间不该当成断链（#1909：
// 监督每轮读 /healthz 见到 503 会反复当断链开新单）。这个窗口有上限（CANARY_PENDING_MAX_MS）：过了还等不到新结论就不是
// 发版窗口了，照实报红，别把「巡检真卡住」永远画成待定。
// 不在正式环境（FLEET_ENV=production，法国是）的（开发、测试）报「未接」。这一项跟着巡检的结论自己变红，发版脚本只标待处理、不退回
// （deploy/release.sh 的 DRIFTING_HEALTH_ITEMS）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CANARY_RUN_TIMEOUT_MINUTES,
  CANARY_STAGE_NAMES,
  type CanaryRunRow,
  type Db,
  latestCanaryRuns,
} from '@fleet-dao/db';
import type { EngineMasterState } from '@fleet-dao/shared';
import { parseTrainState, TRAIN_DIR } from './france-release.ts';
import { PublicHealthError, PublicHealthPending } from './health.ts';

/** 不在正式环境：这一项报「未接」（公网看得到）。 */
export const CANARY_NOT_HERE = '只在正式环境跑';

/** 最近一次通过距今超过这么久，算太久没跑完一轮：6 小时一轮、一轮最长 5 小时，再多给 1 小时。 */
export const CANARY_STALE_MS = 12 * 60 * 60_000;

/**
 * 「结论早于当前部署」这种待定最多认多久（#1909）：新部署后下一轮巡检要等下一个钟点格子（每 6 小时一格，26 分），
 * 一轮最长 5.5 小时（CANARY_RUN_TIMEOUT_MINUTES）。6 + 5.5 取 12 小时。过了还等不到晚于部署的结论，就不是发版窗口，
 * 照实报红——把「巡检自己没跑成、卡住」永远画成待定，等于这一项再不报警。
 */
export const CANARY_PENDING_MAX_MS = 12 * 60 * 60_000;

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** 北京时间「09-27 20:26」。 */
function stamp(at: Date): string {
  const s = new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString();
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`;
}

/** 总开关关着的那一种状态（含为什么关着）。 */
type MasterOff = Extract<EngineMasterState, { on: false }>;

/** 总开关为什么算关着（#1141）：没设过＝默认关；值认不出＝按关算；人关的＝关着。 */
function masterOffWords(state: MasterOff): string {
  if (state.why === 'never_set') return '引擎总开关从没打开过（默认关）';
  if (state.why === 'unreadable') return '引擎总开关的设置认不出，按关算';
  return '引擎总开关关着';
}

/**
 * 总开关关着时，发版进度能解释的那一种（#2084）。
 * 对外的句子不带进度文件里的原因原文：那里面有命令名，公网健康页不收。
 */
export type MasterRelease =
  | { kind: 'pausing'; phase: string; stuck: boolean; restoring: boolean }
  /** 发版中途撤了、而且已经动手发过：按规矩保持暂停，等人开回。 */
  | { kind: 'held'; phase: string }
  /** 发前开着，这一趟已经该开回却还关着。 */
  | { kind: 'not_restored'; phase: string; why: string | null }
  /** 进度文件读不到或认不出：分不清是不是发版暂停，不能把它说成没事。 */
  | { kind: 'unread' };

type TrainOk = Extract<ReturnType<typeof parseTrainState>, { ok: true }>;

function atMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * 发版进度能不能解释「总开关现在关着」。
 * 解释不了（没在发、发前本来就关、关的时刻晚于这一趟结束）回 null，调用方照旧说「总开关关着」。
 * masterAt 是设置行的更新时刻：只有「人关的」才有。晚于这一趟结束，就是发完之后又被关上，不算这一趟没开回。
 */
export function masterReleaseOf(train: TrainOk | null, masterAt: string | undefined): MasterRelease | null {
  if (!train) return null;
  if (train.beforeMaster !== true || train.phaseIndex === null) return null;
  const idx = train.phaseIndex;
  const phase = train.phase;
  const inPause = idx >= 2 && idx < 7;
  const restoring = idx === 7;
  if (train.status === 'running' || train.status === 'blocked') {
    if (inPause || restoring) {
      return { kind: 'pausing', phase, stuck: train.status === 'blocked', restoring };
    }
    // 第 8 步是派清单：恢复那一步已经走过。走到这儿还关着，就是没开回。
    if (idx >= 8) return { kind: 'not_restored', phase, why: train.why };
    return null;
  }
  const off = atMs(masterAt);
  const done = atMs(train.updatedAt);
  const leftByThisTrip = off !== null && done !== null && off <= done;
  if (train.status === 'aborted') {
    // 已经动手发过（第 4 步起）再撤：不把总开关开回，这是定的，不是没恢复成。
    if (idx >= 4) return leftByThisTrip || off === null ? { kind: 'held', phase } : null;
    return leftByThisTrip ? { kind: 'not_restored', phase, why: train.why } : null;
  }
  if (train.status === 'failed') {
    if (idx >= 2 && (leftByThisTrip || off === null)) return { kind: 'not_restored', phase, why: train.why };
    return null;
  }
  // done：发完应已开回。关的时刻不晚于这一趟结束，才是没开回；再晚就是发完之后另有人关的。
  if (train.status === 'done') {
    return leftByThisTrip ? { kind: 'not_restored', phase, why: train.why } : null;
  }
  return null;
}

/** 法国上发版进度那一份；没有这个文件回 null。别的读失败照抛，调用方说「读不到」，不当成没在发。 */
export async function readReleaseTrainJson(dir: string = TRAIN_DIR): Promise<string | null> {
  try {
    return await readFile(join(dir, 'release-train.json'), 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

export type CanaryHealth =
  | { ok: true; note: string }
  /** 待定：不当通过、也不报 canary_broken（结论早于部署、跳过、总开关关着）。 */
  | { ok: 'pending'; note: string }
  | { ok: false; code: string; message: string; detail: string | undefined };

function lastRound(latest: { finished: CanaryRunRow | null }): string {
  const { finished } = latest;
  return finished?.endedAt && finished.verdict
    ? `；最近一轮有结论的是 ${stamp(finished.endedAt)}「${CANARY_STAGE_NAMES[finished.stage] ?? finished.stage}」`
    : '';
}

/** 总开关关着、又能用发版进度解释时，对外那一句（#2084）。解释不了的不进这里。 */
function masterReleaseHealth(
  latest: { finished: CanaryRunRow | null },
  masterOff: MasterOff,
  release: MasterRelease,
): CanaryHealth {
  const last = lastRound(latest);
  if (release.kind === 'unread') {
    return {
      ok: 'pending',
      note: `跳过：${masterOffWords(masterOff)}（发版进度读不到，分不清是不是发版暂停），巡检没跑、没验${last}`,
    };
  }
  if (release.kind === 'pausing') {
    const head = release.restoring
      ? `发版正在把总开关开回（${release.phase}），预计这一步走完`
      : release.stuck
        ? `发版卡在${release.phase}，总开关按这一趟暂停，预计接着走完会开回`
        : `发版进行中（${release.phase}），总开关按这一趟暂停，预计这一趟发完开回`;
    return { ok: 'pending', note: `跳过：${head}；巡检没跑、没验${last}` };
  }
  if (release.kind === 'held') {
    return {
      ok: 'pending',
      note: `跳过：发版中途撤了（${release.phase}），总开关按规矩保持关，原因是已经动手发过。预计重开时间没有，要人定了才开；巡检没跑、没验${last}`,
    };
  }
  return {
    ok: false,
    code: 'master_not_restored',
    message: `总开关没按发版前开回（${release.phase}），巡检因此没跑`,
    detail: release.why ?? undefined,
  };
}

/**
 * 纯判断：最近一轮有结论的、正在跑的那一轮 → 好不好、对外说什么。
 * 还没结论的一轮比最近有结论的那轮开始得早，是早先没收尾的（下一轮开始时补记没跑成），不算在跑；过了一轮工作流的时限
 * 还没结论，工作流已经没了，照实报巡检自己没收尾，不说「在跑」。
 */
export function canaryHealth(
  latest: { finished: CanaryRunRow | null; running: CanaryRunRow | null },
  now: Date,
  /** 引擎总开关此刻的状态（#1141）；只在关着时给（读法见 canaryHealthCheck）。开着传 undefined，照旧按各轮结论判。 */
  masterOff?: MasterOff,
  /**
   * 引擎当前部署时刻（进程起来的时刻，#1808）。最近一轮结论早于它时回待定。
   * 不传＝不做「早于部署」判断（旧调用方、测试）。
   */
  deployedAt?: Date,
  /**
   * 发版进度对「现在关着」的解释（#2084）。不传＝不看发版（旧调用方、测试）。
   * 开着时忽略：发版解释只用于关着的那一支。
   */
  release?: MasterRelease | null,
): CanaryHealth {
  // 总开关关着：巡检的定时任务整个不跑、跳过的轮次不写 canary_runs，翻到的「最近一轮」可能是很久以前的断结论——
  // 不拿它报 canary_broken（#1050 的口径：关着是创始人定的状态，故意不跑不算断），照实说跳过和原因、回待定（#1808：不当通过）。
  // 发版暂停的那几分钟另说（#2084）：写明发完开回，不把这句写成没头没尾的「总开关关着」。
  if (masterOff && !masterOff.on) {
    if (release) return masterReleaseHealth(latest, masterOff, release);
    return { ok: 'pending', note: `跳过：${masterOffWords(masterOff)}，巡检没跑、没验${lastRound(latest)}` };
  }
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
  // 结论早于当前部署：那轮是上一版的，等新一轮再判（#1808）。不拿它报 canary_broken，也不当通过，回待定、不当红（#1909）。
  // 这个待定有上限：发版后等过了 CANARY_PENDING_MAX_MS 还等不到晚于部署的结论，就不是发版窗口了，照实报红——
  // 把「巡检真卡住、没跑出新的一轮」永远画成待定，等于这一项再不报警。
  if (deployedAt && finished.endedAt.getTime() < deployedAt.getTime()) {
    const waited = now.getTime() - deployedAt.getTime();
    if (waited > CANARY_PENDING_MAX_MS) {
      const hours = Math.floor(waited / (60 * 60_000));
      return {
        ok: false,
        code: 'canary_pending_too_long',
        message: `当前部署（${stamp(deployedAt)}）之后 ${hours} 小时没有新结论：巡检没跑出新的一轮`,
        detail: undefined,
      };
    }
    const stageName = CANARY_STAGE_NAMES[finished.stage] ?? finished.stage;
    // 开回总开关之后还没有晚于这次部署的结论：上一轮断在「记账」先不算复发（#2082）。
    // 下一轮巡检（北京时间 2、8、14、20 点 26 分）走出记账之后才能核实。
    const ledger =
      finished.verdict === 'broken' && stageName === '记账'
        ? '；上一轮断在「记账」早于这次部署，开回之后还没有新结论，先不算复发'
        : '';
    return {
      ok: 'pending',
      note: `这条结论早于当前部署（${stamp(deployedAt)}），等新一轮（发版后最多 ${CANARY_PENDING_MAX_MS / (60 * 60_000)} 小时）${ledger}`,
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
  // 跳过（#1050 / #1808）：巡检仓的「让 AI 接活」关着，故意不跑；不当通过（发版期间曾被误判成修好），
  // 也不因太旧改报 canary_stale——一律待定、照实说这一轮什么都没验。
  if (finished.verdict === 'skipped') {
    return {
      ok: 'pending',
      note: `最近一轮 ${when} 跳过：巡检仓的「让 AI 接活」关着，没开单、没验${inFlight}`,
    };
  }
  if (finished.verdict !== 'pass') {
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
      message: `最近一次通过是 ${when}，之后 ${hours} 小时没跑完一轮${inFlight}`,
      detail: undefined,
    };
  }
  const minutes = Math.max(
    1,
    Math.round((finished.endedAt.getTime() - finished.startedAt.getTime()) / 60_000),
  );
  return { ok: true, note: `最近一轮 ${when} 通过（用时 ${minutes} 分钟）${inFlight}` };
}

/**
 * 总开关开回之后，「记账」断点复发了没有（#2082）。
 * 还没有晚于开回时刻的一轮结论：核实不了，recurred 是 null，不当成没复发、也不当成又断了。
 */
export function ledgerRecurrence(input: {
  /** 总开关开回的时刻。 */
  restoredAt: Date;
  /** 晚于开回、并且已经有结论的那一轮。没有是 null。 */
  later: { endedAt: Date; stage: string; verdict: string } | null;
}): { recurred: boolean | null; note: string } {
  if (!input.later || input.later.endedAt.getTime() <= input.restoredAt.getTime()) {
    return {
      recurred: null,
      note: '总开关开回之后还没有一轮新结论，记账断点有没有复发还核实不了',
    };
  }
  if (input.later.verdict === 'broken' && input.later.stage === 'ledger') {
    return { recurred: true, note: '总开关开回之后的一轮仍断在「记账」' };
  }
  return { recurred: false, note: '总开关开回之后的一轮没有断在「记账」' };
}

/**
 * 健康检查：现读库里最近的两轮和引擎总开关（#1141，设置表读不到照抛——报「没查成」，不当成关着、更不当成没问题）；
 * 读不到照抛（报「连不上」，不当成没问题）。好的时候带一句说明。
 * 待定（结论早于部署、跳过、总开关关着、发版暂停中）抛 canary_pending（#1808），而且抛的是 PublicHealthPending（#1909）：
 * 不当通过、也不报 canary_broken，更不让 /healthz 变 503——健康页画成「待定」等着，不当断链。
 * 只有「发版后等太久还等不到新一轮结论」（canary_pending_too_long）、以及「发前开着、发完没开回」
 * （master_not_restored，#2084）这类真卡住照旧抛 PublicHealthError 报红。
 */
export function canaryHealthCheck(
  db: Db,
  readMaster: () => Promise<EngineMasterState>,
  now: () => Date = () => new Date(),
  /**
   * 引擎当前部署时刻（#1808）。默认装配时取一次 now()（进程起来的时刻）；
   * 测试要验「结论晚于部署」时传入更早的时刻。
   */
  deployedAt?: Date,
  /**
   * 发版进度文件的原文（#2084）。不传＝不看发版，关着仍只说「总开关关着」。
   * 正式环境要传：不传的话，发版暂停的那几分钟和真没开回长得一样。
   * 没有这个文件回 null；读失败照抛，这里收成「读不到」，不让整项变成笼统的「连不上」。
   */
  readTrain?: () => Promise<string | null>,
): () => Promise<string> {
  const boot = deployedAt ?? now();
  return async () => {
    const [latest, master] = await Promise.all([latestCanaryRuns(db), readMaster()]);
    let release: MasterRelease | null = null;
    if (!master.on && readTrain) {
      try {
        const json = await readTrain();
        if (json !== null) {
          const parsed = parseTrainState(json);
          release = parsed.ok
            ? masterReleaseOf(parsed, master.why === 'set' ? master.at : undefined)
            : { kind: 'unread' };
        }
      } catch {
        release = { kind: 'unread' };
      }
    }
    const got = canaryHealth(latest, now(), master.on ? undefined : master, boot, release);
    if (got.ok === true) return got.note;
    if (got.ok === 'pending') throw new PublicHealthPending(got.note);
    throw new PublicHealthError(got.code, got.message, got.detail);
  };
}
