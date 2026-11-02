// 按状态切回（决定 0124 讨论稿第五节 3 的切回表，#3783）：一张单走到哪一步，就按那一行退回旧系统，不是一个总开关。
//
// | 单走到哪                 | 怎么办                                                               |
// | 没开始                   | 撤掉活，直接放回旧引擎                                               |
// | 开始了、没有外部动作     | 叫停工人、确认进程没了，再放回                                       |
// | 有本地提交、没推         | 同上；补丁本来就存在 fleet2.publish_runs 里留档；撤掉还没做的推送    |
// | 推了分支、没开 PR        | 分支改名 fleet2-abandoned/…（留着）、撤掉开 PR 的动作，放回          |
// | 开了 PR                  | 不开第二个：人选「交旧引擎接管」或「关掉重派」，按单逐张记           |
// | CI 在跑                  | 等这一轮结果，不在半路转手                                           |
// | 合了                     | 不回退成没做完；有问题走 revert PR                                   |
// | 外部动作结果未知、在对账 | 不转手，等对账出结论                                                 |
// | 补偿失败                 | 停下报警，拍板卡给人（所有权不放）                                   |
// | 确认不了原执行方停没停   | 先叫停并验进程没了；验不了就不转手                                   |
//
// 每一步都幂等：中途停了（补偿失败、等工人收尾）再调一次从头判，已经做完的步骤不会重做。所有权最后才放：令牌一变，
// 还没做的外部动作在执行前核令牌就会被丢进 dead（旧坑 O1）。

import { appendToStream } from '@fleet-dao/harness-api';
import { issueStream, type TaskRef } from '@fleet-dao/harness-contract';
import {
  cancelJob,
  cancelPendingOps,
  type Db,
  events,
  getOp,
  getPublishRun,
  jobs,
  latestPublishRun,
  latestRealBatchFor,
  listOpsForTask,
  type OutboxOp,
  readStream,
  setPublishState,
} from '@fleet-dao/harness-store';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { GitHubWriter } from './github-write.ts';
import { realSessionId } from './real-driver.ts';

export type Stage =
  | 'not-ours'
  | 'not-started'
  | 'worker-running'
  | 'no-external-effect'
  | 'local-commit'
  | 'pushed-no-pr'
  | 'pr-open'
  | 'ci-running'
  | 'merged'
  | 'external-unknown'
  | 'compensation-failed';

export type PrChoice = 'handoff' | 'close';

export type SwitchBackResult =
  | { done: true; stage: Stage; detail: string }
  | {
      done: false;
      stage: Stage;
      /** wait：等一等再调；choose：要人选 PR 怎么办；alarm：停下报警；none：不需要也不能回退（合了） */
      action: 'wait' | 'choose' | 'alarm' | 'none';
      why: string;
    };

export interface SwitchBackDeps {
  db: Db;
  github: GitHubWriter;
  /** 这张单现在的所有权令牌（不归新内核回 -1，读不到抛错）。 */
  fencingOf: (ref: TaskRef) => Promise<number>;
  /** 放回旧系统：令牌对得上才改，回改没改成（task-claim.ts 的 releaseTask）。 */
  release: (
    ref: TaskRef,
    fencing: number,
    to: { state: 'queued' | 'stopped'; doing: string },
  ) => Promise<boolean>;
  /** 同一个派工器最多几次尝试（找工人流用），默认 5。 */
  maxAttempts?: number;
}

interface Facts {
  fencing: number;
  eventId: number | null;
  jobState: string | null;
  workerAlive: boolean;
  run: Awaited<ReturnType<typeof latestPublishRun>>;
  push: OutboxOp | undefined;
  prOp: OutboxOp | undefined;
}

const ABANDONED = (branch: string) => `fleet2-abandoned/${branch.replace(/^fleet2\//, '')}`;

async function gather(d: SwitchBackDeps, ref: TaskRef): Promise<Facts> {
  const fencing = await d.fencingOf(ref);
  const batch = await latestRealBatchFor(d.db, ref);
  let eventId: number | null = null;
  if (batch) {
    const [req] = await d.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.streamId, `session:${realSessionId(batch)}`),
          eq(events.type, 'worker.spawn.requested'),
          sql`${events.payload}->'real'->>'repo' = ${ref.repo}`,
          sql`(${events.payload}->'real'->>'issue')::int = ${ref.issue}`,
        ),
      )
      .orderBy(asc(events.id))
      .limit(1);
    eventId = req?.id ?? null;
  }
  let jobState: string | null = null;
  let workerAlive = false;
  if (eventId !== null) {
    const [job] = await d.db
      .select({ state: jobs.state })
      .from(jobs)
      .where(eq(jobs.key, `spawn:${eventId}`));
    jobState = job?.state ?? null;
    // 起过的工人有没有都收尾了：每次尝试一条流 worker:d<事件号>-a<第几次>，spawned 多于 settled 就是还可能在跑
    for (let a = 1; a <= (d.maxAttempts ?? 5); a++) {
      const evs = await readStream(d.db, `worker:d${eventId}-a${a}`, 0, 20);
      const spawned = evs.filter((e) => e.type === 'worker.spawned').length;
      const settled = evs.filter((e) => e.type === 'worker.settled').length;
      if (spawned > settled) workerAlive = true;
    }
  }
  const ops = await listOpsForTask(d.db, ref);
  const run = await latestPublishRun(d.db, ref);
  const last = (kind: string) =>
    ops.filter((o) => o.kind === kind && (!run || o.opKey.endsWith(`:${run.runId}`))).at(-1);
  return {
    fencing,
    eventId,
    jobState,
    workerAlive,
    run,
    push: last('git.push'),
    prOp: last('github.pr.open'),
  };
}

/** 这张单现在走到切回表的哪一行（只读，不动任何东西）。 */
export async function taskStage(
  d: SwitchBackDeps,
  ref: TaskRef,
): Promise<{ stage: Stage; facts: Facts; pr?: Awaited<ReturnType<GitHubWriter['getPr']>> }> {
  const facts = await gather(d, ref);
  const { run, push, prOp } = facts;
  if (facts.fencing < 0) return { stage: 'not-ours', facts };
  if (!run) {
    if (facts.workerAlive || facts.jobState === 'claimed') return { stage: 'worker-running', facts };
    if (facts.eventId === null || facts.jobState === 'pending') return { stage: 'not-started', facts };
    return { stage: 'no-external-effect', facts };
  }
  if (run.state === 'held' || run.state === 'empty') return { stage: 'no-external-effect', facts };
  if (run.state === 'released') return { stage: 'not-ours', facts };
  // ready：看推送和开 PR 的动作
  const unsure = (o: OutboxOp | undefined) => o && (o.state === 'claimed' || o.state === 'unknown');
  if (unsure(push) || unsure(prOp)) return { stage: 'external-unknown', facts };
  if (prOp?.state === 'done') {
    const number = Number((await readResult(d.db, prOp.opKey))?.number);
    if (!Number.isInteger(number)) return { stage: 'compensation-failed', facts };
    const pr = await d.github.getPr(ref.repo, number);
    if (pr.merged) return { stage: 'merged', facts, pr };
    if (pr.state === 'open') {
      const ci = await d.github.commitStatus(ref.repo, pr.headSha);
      return { stage: ci === 'pending' ? 'ci-running' : 'pr-open', facts, pr };
    }
    return { stage: 'pushed-no-pr', facts, pr };
  }
  // 推了没有：以 GitHub 上分支在不在为准（推送动作可能 dead 了但其实推上了，或响应丢了）
  const onRemote = await d.github.branchSha(ref.repo, run.branch);
  if (onRemote !== null) return { stage: 'pushed-no-pr', facts };
  return { stage: 'local-commit', facts };
}

async function readResult(db: Db, key: string): Promise<Record<string, unknown> | null> {
  const op = await getOp(db, key);
  return (op?.result as Record<string, unknown> | null) ?? null;
}

/**
 * 按状态把单放回旧系统。能放的做完、回 done；该等的（工人没收尾、CI 在跑、结果未知）回 wait，过会儿再调；
 * 开了 PR 的要人选 pr（handoff / close）；补偿失败停下报警，所有权不放。每次调用都先重新判状态，重复调没有副作用。
 */
export async function switchBack(
  d: SwitchBackDeps,
  ref: TaskRef,
  opts: { pr?: PrChoice; why?: string } = {},
): Promise<SwitchBackResult> {
  const why = opts.why ?? '切回旧系统';
  const { stage, facts, pr } = await taskStage(d, ref);
  const note = async (payload: Record<string, unknown>) => {
    await appendToStream(d.db, issueStream(ref), 'task.released', {
      stage,
      fencing: facts.fencing,
      why,
      ...payload,
    });
  };
  const hold = async (
    action: 'wait' | 'choose' | 'alarm' | 'none',
    msg: string,
  ): Promise<SwitchBackResult> => {
    return { done: false, stage, action, why: msg };
  };

  switch (stage) {
    case 'not-ours':
      return { done: true, stage, detail: '这张单已经不归新内核了，没有要切回的' };
    case 'merged':
      return hold('none', `PR #${pr?.number} 已经合了，不回退成没做完；有问题走 revert PR`);
    case 'ci-running':
      return hold('wait', `PR #${pr?.number} 的检查还在跑，等这一轮结果再切，不在半路转手`);
    case 'external-unknown':
      return hold('wait', '有外部动作结果还不知道（在领取或对账中），不转手，等出结论');
    case 'compensation-failed':
      return hold('alarm', '开 PR 的动作记成做完了但读不到 PR 号，停下报警，交给人');
    case 'pr-open':
      if (!opts.pr) {
        return hold(
          'choose',
          `PR #${pr?.number} 开着：选「handoff」交旧引擎接管，或「close」关掉重派；不会开第二个`,
        );
      }
      break;
    default:
      break;
  }

  // ---- 到这里该放了。先叫停还在跑的工人：撤活，工人的心跳下次就会知道
  if (facts.eventId !== null && (stage === 'worker-running' || stage === 'not-started')) {
    await cancelJob(d.db, `spawn:${facts.eventId}`, `切回：${why}`);
  }
  if (stage === 'worker-running') {
    // 这一轮刚叫停（活还领着）、或工人流里起了没收尾：不转手，等下一次调用再确认进程没了
    return hold('wait', '已叫停工人，等它收尾、确认进程没了再放');
  }
  // 撤掉还没做的外部动作；claimed / unknown 的上面已经拦住
  const cancelled = await cancelPendingOps(d.db, ref, `切回：${why}`);

  let detail = `阶段 ${stage}，撤掉 ${cancelled} 个还没做的外部动作`;
  let to: { state: 'queued' | 'stopped'; doing: string } = {
    state: 'queued',
    doing: `新内核切回（${stage}），旧引擎重新拉`,
  };
  try {
    if (stage === 'pushed-no-pr' && facts.run) {
      const abandoned = ABANDONED(facts.run.branch);
      if ((await d.github.branchSha(ref.repo, facts.run.branch)) !== null) {
        await d.github.renameBranch(ref.repo, facts.run.branch, abandoned);
      }
      detail += `；分支改名 ${abandoned} 留着`;
    }
    if (stage === 'pr-open' && pr) {
      if (opts.pr === 'close') {
        await d.github.closePr(ref.repo, pr.number);
        detail += `；PR #${pr.number} 已关掉（没合并），旧引擎重新派`;
      } else {
        to = { state: 'stopped', doing: `新内核切回：PR #${pr.number} 交旧引擎接管（${pr.url}）` };
        detail += `；PR #${pr.number} 留着，交旧引擎接管续它`;
      }
    }
  } catch (err) {
    const msg = `补偿没成：${err instanceof Error ? err.message : String(err)}`;
    await note({ ok: false, error: msg.slice(0, 500) });
    return hold('alarm', `${msg}。停下报警，所有权不放，交给人`);
  }
  if (facts.run && facts.run.state !== 'released') {
    const fresh = await getPublishRun(d.db, facts.run.runId);
    if (fresh && fresh.state !== 'released')
      await setPublishState(d.db, fresh.runId, 'released', `切回：${why}`);
  }
  const released = await d.release(ref, facts.fencing, to);
  if (!released) {
    await note({ ok: false, error: '放回旧系统时令牌对不上（别人先动了）' });
    return hold('alarm', '放回旧系统时所有权令牌对不上，别人先动过这张单，停下报警');
  }
  await note({
    ok: true,
    detail,
    pr: pr ? { number: pr.number, url: pr.url, choice: opts.pr ?? null } : null,
  });
  return { done: true, stage, detail };
}
