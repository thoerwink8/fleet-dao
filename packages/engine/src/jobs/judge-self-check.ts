// 判断题健康自检（#1365）：最近一次真调用失败、又超过 30 分钟没有新调用时，用一道固定的小题再问一次上游。
// 结果写进 jev_answers，当作「最近一次」。通过就让 /healthz 的 judge 项变绿；自检也失败才继续红，原因以「自检失败」开头。
// 不走 createJev：那条路会计入每日次数和花费。自检题号也不进那两笔账。
// 不标 needsMaster：总开关每次发版都会关，标了红灯就探不回来。这一轮不拉单、不起会话。
// 改这里之前必须知道：
// - 不发（最近一次成功、还没调过、失败还没超过 30 分钟）记 ok、scanned 1、found 0。记成 unscanned 看门狗会报「一个都没扫到」。
// - 发出去了但上游没答上、答错：记 partial，why 写明自检失败，不抛。抛了看门狗会再报一条「没跑成」，和健康检查的红灯重复。
// - 该发但没接、起不来：不写一条成功的判断记录，记 partial。
// - 只有没记上（查库、写库抛了）才记 failed 再抛。

import type { Db, ScheduleResult } from '@fleet-dao/db';
import {
  type BackendResult,
  type JevSetup,
  lastSentCall,
  probeDue,
  probeRequest,
  recordProbeCall,
} from '@fleet-dao/jev';
import { errMessage } from '@fleet-dao/shared/util';
import type { JudgeSelfCheckRun } from '../contract.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';

/** 每 30 分钟一轮。 */
export const JUDGE_SELF_CHECK_EVERY_MINUTES = 30;
/**
 * 每小时 17、47 分。拉单每 5 分钟、错 3，:13 和 :43 会撞；每小时对账错 41，:41 会撞。
 * 17 落在 :17 和 :47，和拉单、对账、读额度、探针、看门狗都不撞。
 */
export const JUDGE_SELF_CHECK_OFFSET_MINUTES = 17;

export const JUDGE_SELF_CHECK_JOB = {
  id: 'judge-self-check',
  name: '判断题自检',
  schedule: '每 30 分钟（每小时 17、47 分）',
  // 连着三轮没跑成才算过期。
  expectEveryMinutes: 90,
} as const;

export interface JudgeSelfCheckJobDeps {
  db: Db;
  /** 现找后端。生产：resolveJevBackend 读 jev.json 和路由两层里判断用途排第一的路由。 */
  resolve(): Promise<JevSetup>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 这一轮没记上：结局已经记进 schedule_runs，再抛出去，调用方不会把它当成跑成了。 */
export class JudgeSelfCheckFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'JudgeSelfCheckFailedError';
    this.runId = runId;
  }
}

type Round = { sent: boolean; result: ScheduleResult };

async function oneRound(deps: JudgeSelfCheckJobDeps): Promise<Round> {
  const now = deps.now();
  const last = await lastSentCall(deps.db);
  const due = probeDue(last, now);
  if (!due.send) {
    deps.log('info', due.why);
    return { sent: false, result: { outcome: 'ok', scanned: 1, found: 0 } };
  }
  const setup = await deps.resolve();
  if (setup.state === 'absent') {
    return {
      sent: false,
      result: { outcome: 'partial', why: `没接判断题（没有 ${setup.path}），不发自检`, scanned: 1, found: 0 },
    };
  }
  if (setup.state === 'broken') {
    return {
      sent: false,
      result: { outcome: 'partial', why: `判断题起不来，不发自检：${setup.problem}`, scanned: 1, found: 1 },
    };
  }
  let backendResult: BackendResult;
  try {
    backendResult = await setup.backend.ask(probeRequest());
  } catch (err) {
    backendResult = {
      ok: false,
      reason: 'backend_error',
      detail: `后端抛了异常：${errMessage(err)}`,
      latencyMs: 0,
    };
  }
  const verdict = await recordProbeCall(deps.db, {
    backend: setup.backend,
    routeId: setup.routeId,
    result: backendResult,
    at: now,
  });
  if (verdict.ok) return { sent: true, result: { outcome: 'ok', scanned: 1, found: 0 } };
  return { sent: true, result: { outcome: 'partial', why: verdict.detail, scanned: 1, found: 1 } };
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会过期，看门狗看得见。
 * 没记上：记成 failed 再抛 JudgeSelfCheckFailedError。自检没通过只记 partial，不抛。
 */
export async function runJudgeSelfCheckJob(deps: JudgeSelfCheckJobDeps): Promise<JudgeSelfCheckRun> {
  const runId = await deps.runs.start(JUDGE_SELF_CHECK_JOB.id, deps.now());
  let round: Round;
  try {
    round = await oneRound(deps);
  } catch (err) {
    const why = `判断题自检没记上：${errMessage(err)}`;
    await deps.runs.finish(runId, { outcome: 'failed', why }, deps.now());
    deps.log('error', '判断题自检这一轮没记上', { runId, why });
    throw new JudgeSelfCheckFailedError(runId, why);
  }
  const { result, sent } = round;
  await deps.runs.finish(runId, result, deps.now());
  const run: JudgeSelfCheckRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    sent,
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, sent };
  if (run.outcome === 'ok') deps.log('info', sent ? '判断题自检通过' : '判断题自检这一轮不发', fields);
  else deps.log('warn', '判断题自检没通过', { ...fields, why: run.why });
  return run;
}
