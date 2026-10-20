// 原停点的只读预检。调用者不能提供 actor 终态、树身份、用量或 Activity 来源。
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { invokeTreeHelper, treeIdentity } from '@fleet-dao/adapters';
import type { RunRow } from '@fleet-dao/db';
import { Context } from '@temporalio/activity';
import { Client, Connection } from '@temporalio/client';
import type { PortContext } from '../ports.ts';
import {
  type PushHandbackPreflight,
  type PushHandbackPreflightInput,
  validHandbackContract,
} from '../push-handback.ts';
import {
  type RequirementContract,
  sameRequirementContract,
  type TaskBrief,
  type TaskBriefResult,
} from '../runner/task-brief.ts';
import {
  MAX_IMPLEMENT_ROUNDS,
  MAX_VERIFY_ROUNDS,
  type ReadTaskBriefInput,
  type TaskSpendResult,
  taskPushHandbackQuery,
} from '../task-contract.ts';
import type { UserExec } from './exec.ts';
import { readNaturalPushHistory } from './push-handback-history.ts';
import { readHandbackTree } from './push-handback-tree.ts';
import type { UserTree } from './user-git.ts';
import type { WorkTrees } from './worktrees.ts';

export interface PushHandbackPreflightDeps {
  address: string;
  namespace: string;
  taskQueue: string;
  runsDir: string;
  trees: WorkTrees;
  exec: UserExec;
  getRun(id: string): Promise<RunRow | null>;
  openRuns(input: PushHandbackPreflightInput): Promise<number>;
  spend(taskId: string, since: Date): Promise<TaskSpendResult>;
  brief(input: ReadTaskBriefInput, ctx: PortContext): Promise<TaskBriefResult>;
}

/** Trusted state files: pin each directory and reject links before reading a bounded regular result. */
async function resultFile(runsDir: string, id: string): Promise<Record<string, unknown>> {
  let dir = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of join(runsDir, id).split('/').filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${dir.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await dir.close();
      dir = next;
    }
    const file = await open(`/proc/self/fd/${dir.fd}/result.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size > 64 * 1024) throw new Error('result_limit');
      const bytes = Buffer.alloc(64 * 1024 + 1);
      const count = await file.read(bytes, 0, bytes.length, 0);
      if (count.bytesRead !== st.size) throw new Error('result_changed');
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count.bytesRead)),
      );
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('result_malformed');
      return value as Record<string, unknown>;
    } finally {
      await file.close();
    }
  } finally {
    await dir.close();
  }
}

export function createPushHandbackPreflight(deps: PushHandbackPreflightDeps) {
  return async (input: PushHandbackPreflightInput, ctx: PortContext): Promise<PushHandbackPreflight> => {
    try {
      const { info } = Context.current();
      if (
        info.isLocal ||
        info.activityType !== 'readPushHandbackPreflight' ||
        info.attempt !== 1 ||
        info.workflowNamespace !== deps.namespace ||
        info.taskQueue !== deps.taskQueue ||
        info.workflowExecution?.workflowId !== input.workflowId ||
        info.workflowExecution?.runId !== input.runId
      )
        return { outcome: 'unknown', code: 'activity_identity' };
      return await observe(deps, input, ctx, info.activityId);
    } catch {
      return { outcome: 'unknown', code: 'activity_context' };
    }
  };
}

/** 真只读入口：只查询精确 run，不发 Update/Signal，不在 Temporal 历史写证据。报告不是交还凭据。 */
export function createPushHandbackChecker(deps: PushHandbackPreflightDeps) {
  return async (
    workflowId: string,
    runId: string,
    signal: AbortSignal,
    revision?: { originalContract: RequirementContract; expectedContract: RequirementContract },
  ): Promise<PushHandbackPreflight> => {
    let connection: Connection | undefined;
    try {
      if (
        !workflowId ||
        workflowId.length > 1024 ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId)
      )
        return { outcome: 'unknown', code: 'check_identity' };
      signal = AbortSignal.any([signal, AbortSignal.timeout(220_000)]);
      connection = await Connection.connect({
        connectTimeout: 10_000,
        address: deps.address,
        interceptors: [],
        channelArgs: { 'grpc.max_receive_message_length': 2 * 1024 * 1024 },
      });
      const client = new Client({ connection, namespace: deps.namespace });
      const handle = client.workflow.getHandle(workflowId, runId);
      const query = () =>
        connection!.withAbortSignal(signal, () =>
          connection!.withDeadline(Date.now() + 10_000, () => handle.query(taskPushHandbackQuery)),
        );
      const original = await query();
      if (!original || original.workflowId !== workflowId || original.runId !== runId)
        return { outcome: 'unknown', code: 'unsupported_or_not_eligible' };
      if (
        revision &&
        (!validHandbackContract(revision.originalContract) ||
          !validHandbackContract(revision.expectedContract) ||
          !sameRequirementContract(original.contract, revision.originalContract))
      )
        return { outcome: 'unknown', code: 'original_contract' };
      const input: PushHandbackPreflightInput = revision
        ? {
            ...original,
            version: 2,
            requestId: 'readonly-check',
            expectedContract: revision.expectedContract,
          }
        : original;
      const result = await observe(deps, input, {
        signal,
        attempt: 1,
        lastHeartbeat: undefined,
        heartbeat() {},
      });
      if (JSON.stringify(await query()) !== JSON.stringify(original))
        return { outcome: 'unknown', code: 'check_changed' };
      signal.throwIfAborted();
      return result;
    } catch {
      return { outcome: 'unknown', code: signal.aborted ? 'cancelled' : 'check_read_failed' };
    } finally {
      await connection?.close();
    }
  };
}

async function observe(
  deps: PushHandbackPreflightDeps,
  input: PushHandbackPreflightInput,
  ctx: PortContext,
  activityId?: string,
): Promise<PushHandbackPreflight> {
  ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(210_000)]) };
  // DB/文件源即便自身不响应取消，也只能让本次只读观察返回未知，不能挂住 Update。
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    ctx.signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(ctx.signal.reason);
      ctx.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([operation(), cancelled]);
    } finally {
      ctx.signal.removeEventListener('abort', abort);
    }
  };
  const heartbeat = setInterval(() => ctx.heartbeat({ step: 'permission-push-preflight' }), 1000);
  let connection: Connection | undefined;
  let code = 'context';
  try {
    if (
      (input.version !== 1 && input.version !== 2) ||
      !validHandbackContract(input.contract) ||
      (input.version === 2 &&
        (!validHandbackContract(input.expectedContract) ||
          typeof input.requestId !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.requestId))) ||
      input.token.runId !== input.runId ||
      input.token.kind !== 'parked' ||
      input.token.generation !== 1 ||
      input.token.continued !== 0 ||
      input.path !== deps.trees.treeFor(input.task.repo, input.branch) ||
      !Number.isSafeInteger(input.budgetGrants) ||
      input.budgetGrants < 1 ||
      !Number.isSafeInteger(input.taskTokenBudget) ||
      input.taskTokenBudget <= 0 ||
      !Number.isSafeInteger(input.round) ||
      input.round < 1 ||
      !Number.isSafeInteger(input.verifyRound) ||
      input.verifyRound < 0 ||
      !posix.isAbsolute(deps.runsDir)
    )
      throw new Error('identity');
    if (input.round >= MAX_IMPLEMENT_ROUNDS || input.verifyRound >= MAX_VERIFY_ROUNDS)
      return { outcome: 'budget-held', code: 'round_budget' };
    ctx.signal.throwIfAborted();
    code = 'history';
    connection = await Connection.connect({
      connectTimeout: 10_000,
      address: deps.address,
      interceptors: [],
      channelArgs: { 'grpc.max_receive_message_length': 2 * 1024 * 1024 },
    });
    const history = await readNaturalPushHistory(
      connection,
      deps.namespace,
      input,
      activityId,
      deps.taskQueue,
      ctx.signal,
    );
    code = 'run_evidence';
    for (const id of history.runIds) {
      const row = await read(() => deps.getRun(id));
      if (
        !row ||
        row.id !== id ||
        row.taskId !== input.task.taskId ||
        row.issueNumber !== input.task.issueNumber ||
        row.workflowId !== input.workflowId ||
        (row.temporalRunId !== null && row.temporalRunId !== input.runId) ||
        row.branch !== input.branch ||
        row.worktreePath !== input.path ||
        row.outcome !== 'done' ||
        !row.endedAt ||
        !row.sessionId ||
        row.startedAt.getTime() < history.sinceMs ||
        row.endedAt < row.startedAt ||
        row.endedAt.getTime() > Date.now()
      )
        throw new Error('run_identity');
      const persisted = await read(() => resultFile(deps.runsDir, id));
      if (
        persisted.runId !== id ||
        persisted.outcome !== 'done' ||
        persisted.exitCode !== 0 ||
        Date.parse(String(persisted.startedAt)) !== row.startedAt.getTime() ||
        Date.parse(String(persisted.endedAt)) !== row.endedAt.getTime()
      )
        throw new Error('result_identity');
    }
    if ((await read(() => deps.openRuns(input))) !== 0) throw new Error('active_runs');
    const checkBudget = async (): Promise<boolean> => {
      const spent = await read(() => deps.spend(input.task.taskId, new Date(history.sinceMs)));
      const value = spent.inputEquivalent ?? spent.weighted ?? spent.tokens;
      const estimate =
        spent.inputEquivalent !== undefined
          ? spent.inputEquivalentEstimated
          : spent.weighted !== undefined
            ? spent.weightedEstimated
            : spent.estimated;
      if (
        ![value, estimate, spent.runs, spent.unmetered].every(
          (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
        ) ||
        spent.unmetered > 0 ||
        spent.runs < history.runIds.length
      )
        throw new Error('budget_unknown');
      return value + estimate! <= input.taskTokenBudget * input.budgetGrants;
    };
    code = 'budget';
    if (!(await checkBudget())) return { outcome: 'budget-held', code: 'token_budget' };
    let snapshot: TaskBrief | undefined;
    const checkContract = async () => {
      const brief = await read(() =>
        deps.brief(
          {
            schemaVersion: 1,
            repo: input.task.repo,
            issueNumber: input.task.issueNumber,
            checkContract: true,
          },
          ctx,
        ),
      );
      const expected = input.version === 2 ? input.expectedContract : input.contract;
      if (
        !brief.ok ||
        !sameRequirementContract(expected, brief.brief.contract) ||
        (input.version === 2 && brief.brief.issueNumber !== input.task.issueNumber)
      )
        throw new Error('contract_changed');
      snapshot = brief.brief;
    };
    code = 'contract';
    await checkContract();
    code = 'tree';
    const user = await read(() => deps.trees.ownerOf(input.path));
    if (!user) throw new Error('owner_unknown');
    const tree: UserTree = {
      user,
      dir: input.path,
      exec: deps.exec,
      scopePrefix: `handback-${activityId ?? 'check'}`.slice(0, 40),
      signal: ctx.signal,
    };
    const initial = await readHandbackTree(tree, input.branch, history.failedHead);
    const { identity: original, head } = initial;
    code = 'retirement';
    const retirement = await invokeTreeHelper({ signal: ctx.signal }, [
      'retirement',
      JSON.stringify({
        version: 1,
        identity: original,
        runIds: history.runIds,
        worker: history.worker,
        sinceMs: history.sinceMs,
        untilMs: Date.now(),
      }),
    ]);
    if (
      retirement.state !== 'natural-retired' ||
      JSON.stringify(treeIdentity(retirement.identity)) !== JSON.stringify(original) ||
      retirement.worker !== history.worker ||
      JSON.stringify(retirement.runIds) !== JSON.stringify(history.runIds) ||
      retirement.failed !== 0 ||
      !Number.isSafeInteger(retirement.scanned) ||
      Number(retirement.scanned) < 1 ||
      typeof retirement.bootId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(retirement.bootId) ||
      typeof retirement.invocationId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(retirement.invocationId) ||
      !Number.isSafeInteger(retirement.helperCount) ||
      Number(retirement.helperCount) < 1 ||
      Number(retirement.helperCount) > 512 ||
      !Array.isArray(retirement.scopes) ||
      retirement.scopes.length < history.runIds.length ||
      retirement.scopes.length > 256
    )
      throw new Error('retirement_identity');
    const lowerUs = BigInt(history.sinceMs) * 1000n,
      upperUs = BigInt(Date.now()) * 1000n;
    const instant = (v: unknown): bigint => {
      if (typeof v !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v)) throw new Error('retirement_time');
      const n = BigInt(v);
      if (n < lowerUs || n > upperUs) throw new Error('retirement_time');
      return n;
    };
    instant(retirement.engineStoppedUs);
    const scopeIds = new Set<string>();
    for (const entry of retirement.scopes) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('retirement_scope');
      const s = entry as Record<string, unknown>;
      if (
        Object.keys(s).sort().join(',') !== 'endedUs,id,startedUs' ||
        typeof s.id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(s.id) ||
        scopeIds.has(s.id) ||
        instant(s.endedUs) < instant(s.startedUs)
      )
        throw new Error('retirement_scope');
      scopeIds.add(s.id);
    }
    if (history.runIds.some((id) => !scopeIds.has(id))) throw new Error('retirement_run_scope');
    code = 'recheck';
    await checkContract();
    if (
      (await read(() => deps.openRuns(input))) !== 0 ||
      !(await checkBudget()) ||
      (await readHandbackTree(tree, input.branch, history.failedHead)).fingerprint !== initial.fingerprint
    )
      throw new Error('observation_changed');
    ctx.signal.throwIfAborted();
    if (input.version === 2 && !snapshot) return { outcome: 'unknown', code: 'contract_snapshot' };
    return {
      outcome: 'natural-retired',
      head,
      evidenceSha256: createHash('sha256')
        .update(
          JSON.stringify({
            history: history.sha256,
            retirement,
            head,
            contract: input.contract,
            ...(input.version === 2
              ? { requestId: input.requestId, expectedContract: input.expectedContract }
              : {}),
          }),
        )
        .digest('hex'),
      ...(input.version === 2 && snapshot ? { brief: snapshot } : {}),
    };
  } catch {
    return { outcome: 'unknown', code: ctx.signal.aborted ? 'cancelled' : code };
  } finally {
    clearInterval(heartbeat);
    await connection?.close();
  }
}
