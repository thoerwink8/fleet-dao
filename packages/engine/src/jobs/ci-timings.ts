// 每周刷新 CI 测试耗时表（#921 第 1 条）：取最近几轮 PR 触发、真跑了测试的 ci.yml 日志，重写 test-timings.json，开一个自己带检查地合的 PR。
// 取数、合并、写成什么样都复用 conventions 的 ci-timings（parseRunLog / medianOfRuns / mergeTimings / renderTimings），这里只排一轮怎么跑。
// 改这里之前必须知道：
// - 这是定时任务，不进 CI（#299：CI 的判定只看检出来的文件）。钟点登记在 jobs/schedules.ts，由进程内定时器每周跑一次。
// - 只取 PR 触发的全量日志（#1192 验收）：最近 40 次 PR 触发的绿的 ci.yml 里，头 5 次至少 4 台 `test (` 成功的（台数门槛和
//   `pnpm ci:timings` 同一组常量）。主线运行不算：主线多半复用同树的 PR 检查、根本不跑测试；小 PR 只有一两台的也不算。
// - 先按现表的 source 重写再比字节：一样就不开 PR。source 里的日期和运行编号每周都会换，不拿它当「表变了」。
//   表里仍缺文件、文件和毫秒却没变时同样不开，缺多少只记日志。
// - 日志读不到、运行列表认不出、一轮都没有、某一轮一个文件都没认出来、量到的文件全都不在仓里：记没查成再抛，不开 PR、不记成功。
//   耗时表文件还不存在不算没查成，按没有旧表重写并开 PR。
// - 不标 needsMaster：总开关每次发版都会关（#1086），标了每周这一轮几乎跑不上。这一轮不拉单、不起会话。

import {
  medianOfRuns,
  mergeTimings,
  parseRunLog,
  parseTimings,
  renderTimings,
  TIMINGS_AUTO_MIN_BOXES,
  TIMINGS_AUTO_RUNS,
  TIMINGS_AUTO_SCAN,
  TIMINGS_FILE,
  timingsSource,
} from '@fleet-dao/conventions';
import type { ScheduleResult } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { ScheduleRunLog } from './github-reconcile.ts';

export { timingsSource };

/** 一周一次。 */
export const CI_TIMINGS_EVERY_MINUTES = 7 * 24 * 60;
/**
 * 周一 06:00（北京时间，UTC+8）= 周日 22:00 UTC。epoch 是周四 00:00 UTC，再过 3 天 22 小时。
 * 1970-01-04 22:00 UTC 起每 7 天一格。
 */
export const CI_TIMINGS_OFFSET_MINUTES = 3 * 24 * 60 + 22 * 60;
/** 下日志比别的定时任务慢，超过一小时还没回才记超时（只记日志，不另起一轮）。 */
export const CI_TIMINGS_OVERDUE_MINUTES = 60;

export const CI_TIMINGS_JOB = {
  id: 'ci-timings',
  name: '刷新 CI 测试耗时表',
  schedule: '每周一 06:00（北京时间）',
  // 两周没跑成才算过期：一周一次，多给一格余量。
  expectEveryMinutes: CI_TIMINGS_EVERY_MINUTES * 2,
} as const;

const PR_TITLE = '刷新 CI 测试耗时表';

export interface OpenTimingsPrInput {
  title: string;
  body: string;
  /** 要写进分支的整份 test-timings.json。 */
  content: string;
  /** 读表和列测试文件时的那个提交：分支从这里拉开。 */
  baseCommit: string;
  at: Date;
}

/** 真实现在 real/ci-timings.ts（GitHub API）。测试注入假的，不连 GitHub。 */
export interface CiTimingsGitHub {
  /** 最近 limit 次 PR 触发的成功的 ci.yml 运行，新的在前，主线运行不要。列表认不出、混进非 PR 的要抛，不许回空列表冒充「没有」。 */
  listSuccessfulRuns(limit: number): Promise<{ id: string }[]>;
  /** 这一轮成功的 `test (` 台数。认不出要抛。 */
  successfulTestBoxes(runId: string): Promise<number>;
  /**
   * 这一轮测试台的日志，拼成 `gh run view --log` 的样子（每行 `job 名<TAB>步骤<TAB>其余`），好让 parseRunLog 直接认。
   * 读不到要抛。
   */
  runLog(runId: string): Promise<string>;
  /** 默认分支头：提交、耗时表原文（文件不在是 null）、仓里的测试文件。读不到要抛；文件不在不是抛。 */
  readHead(): Promise<{ commit: string; timingsText: string | null; testFiles: string[] }>;
  /** 建分支、写入、开 PR、挂自动合并。没开成要抛（PR 可能已经开了，错误信息里写明）。 */
  openPr(input: OpenTimingsPrInput): Promise<{ number: number; url: string }>;
}

export interface CiTimingsJobDeps {
  github: CiTimingsGitHub;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 这一轮没查成：结局已经记进 schedule_runs，再抛出去，调用方不会把它当成跑成了。 */
export class CiTimingsFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'CiTimingsFailedError';
    this.runId = runId;
  }
}

/** 失败原因里带上「没查成」，已经带了的不再加一遍。 */
function unread(why: string): string {
  return why.includes('没查成') ? why : `没查成：${why}`;
}

async function pickRuns(github: CiTimingsGitHub): Promise<{ ids: string[]; scanned: number }> {
  const runs = await github.listSuccessfulRuns(TIMINGS_AUTO_SCAN);
  const ids: string[] = [];
  for (const run of runs) {
    if (!/^[1-9]\d*$/.test(run.id)) throw new Error(`ci.yml 运行编号认不出：${run.id}`);
    const boxes = await github.successfulTestBoxes(run.id);
    if (!Number.isInteger(boxes) || boxes < 0) throw new Error(`运行 ${run.id} 的测试台数认不出`);
    if (boxes >= TIMINGS_AUTO_MIN_BOXES) ids.push(run.id);
    if (ids.length === TIMINGS_AUTO_RUNS) break;
  }
  return { ids, scanned: runs.length };
}

function prBody(rounds: number): string {
  return [
    `**做了什么**：用最近 ${rounds} 轮 PR 触发、真跑了测试的 ci.yml 日志重写 \`${TIMINGS_FILE}\`（取日志、合并、写法复用 pnpm ci:timings）。`,
    '',
    '**需求**：无：每周定时刷新 CI 测试耗时表，没有对应的单',
    '',
  ].join('\n');
}

async function refresh(deps: CiTimingsJobDeps): Promise<ScheduleResult> {
  const picked = await pickRuns(deps.github);
  if (picked.ids.length === 0) {
    return {
      outcome: 'failed',
      why: unread(
        `最近 ${picked.scanned} 次 PR 触发的绿的 ci.yml 运行里没有一次真跑了 ${TIMINGS_AUTO_MIN_BOXES} 台以上的测试台`,
      ),
      scanned: picked.scanned,
    };
  }
  const perRun: Map<string, number>[] = [];
  const names: string[] = [];
  for (const id of picked.ids) {
    const name = `ci.yml run ${id}`;
    const measured = parseRunLog(await deps.github.runLog(id));
    if (measured.size === 0) {
      throw new Error(`${name} 的日志里一个测试文件的耗时都没认出来`);
    }
    perRun.push(measured);
    names.push(name);
  }
  const measured = medianOfRuns(perRun);
  if (measured === undefined) throw new Error('一轮日志都没有');
  const head = await deps.github.readHead();
  const parsed = parseTimings(head.timingsText ?? undefined);
  if (typeof parsed === 'string') deps.log('warn', `旧表认不出（${parsed}），这次只用新量的`);
  const at = deps.now();
  const freshSource = timingsSource(names, at);
  const old = typeof parsed === 'string' ? undefined : parsed;
  // source 每周都会换成今天的日期和这周的运行编号。先沿用现表的 source 重写：字节一样就说明文件和毫秒没变，不开 PR。
  const keptSource = old?.source ?? freshSource;
  const mergedKept = mergeTimings(old, measured, head.testFiles, keptSource);
  if (measured.size > 0 && [...measured.keys()].every((f) => !head.testFiles.includes(f))) {
    return {
      outcome: 'failed',
      why: unread(`日志里量到的 ${measured.size} 个测试文件一个都不在仓里`),
      scanned: names.length,
    };
  }
  const missing = head.testFiles.filter((f) => mergedKept.timings.files[f] === undefined);
  if (head.timingsText !== null && renderTimings(mergedKept.timings) === head.timingsText) {
    if (missing.length > 0) {
      deps.log('warn', `耗时表和现表一样，不开 PR；表里还缺 ${missing.length} 个`);
    }
    return { outcome: 'ok', scanned: names.length, found: 0 };
  }
  const merged =
    keptSource === freshSource ? mergedKept : mergeTimings(old, measured, head.testFiles, freshSource);
  const rendered = renderTimings(merged.timings);
  try {
    const pr = await deps.github.openPr({
      title: PR_TITLE,
      body: prBody(names.length),
      content: rendered,
      baseCommit: head.commit,
      at,
    });
    deps.log('info', `耗时表 PR #${pr.number}`, { url: pr.url });
  } catch (err) {
    const why = errMessage(err);
    return {
      outcome: 'failed',
      why: why.includes('没查成') ? unread(why) : `开 PR 没成：${why}`,
      scanned: names.length,
    };
  }
  return { outcome: 'ok', scanned: names.length, found: 1 };
}

/**
 * 跑一轮。记开始就失败（库连不上）：原样抛出，这一轮在库里没有记录。
 * 没查成：记成 failed 再抛 CiTimingsFailedError，不记成功。
 */
export async function runCiTimingsJob(deps: CiTimingsJobDeps): Promise<ScheduleResult> {
  const runId = await deps.runs.start(CI_TIMINGS_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await refresh(deps);
  } catch (err) {
    result = { outcome: 'failed', why: unread(errMessage(err)) };
  }
  await deps.runs.finish(runId, result, deps.now());
  if (result.outcome !== 'ok') {
    const why = 'why' in result ? result.why : '刷新 CI 测试耗时表没查成';
    deps.log('error', '刷新 CI 测试耗时表这一轮没查成', { runId, why });
    throw new CiTimingsFailedError(runId, why);
  }
  deps.log('info', result.found === 0 ? '耗时表没有变化，不开 PR' : '耗时表开了 PR', {
    runId,
    scanned: result.scanned,
    found: result.found,
  });
  return result;
}
