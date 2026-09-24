// 和驾驶舱后端（packages/api）的约定：两边各写各的，这里拿后端真的代码来对。
// 1. fleet 通行证：引擎签，后端验，两边得是一回事。
// 2. 信号：后端按 TaskSignal 发（信号名 = name，参数 = 其余字段），引擎按同名同形收。
import {
  AGENT_TOKEN_MAX_TTL_SECONDS,
  createTemporalWorkflowControl,
  type TaskSignal,
  verifyAgentToken,
} from '@fleet-dao/api';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentTokenTtlSeconds } from '../src/activities.ts';
import {
  type AgentEventCommand,
  type AnswerCommand,
  type CommandMeta,
  type NEW_TASK_SIGNAL_NAMES,
  type RequirementResult,
  type RequirementStatus,
  type RerouteCommand,
  requirementWorkflowId,
  type SubtaskStatus,
  subtaskWorkflowId,
  type TASK_SIGNAL_NAMES,
  WORKFLOW_TYPES,
} from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { agentTokenSignerFromEnv } from '../src/worker.ts';
import { queryUntil, requirementInput, useEnv, waitUntil, withWorker } from './helpers.ts';

// ---- 编译期：后端发的每种信号，引擎都有同名的、参数收得下的定义。
type ApiName = TaskSignal['name'];
type ArgOf<N extends ApiName> = Omit<Extract<TaskSignal, { name: N }>, 'name'>;
type Missing = Exclude<ApiName, (typeof TASK_SIGNAL_NAMES)[number]>;
type Extra = Exclude<(typeof TASK_SIGNAL_NAMES)[number], ApiName>;
const noneMissing: [Missing] extends [never] ? true : Missing = true;
const noneExtra: [Extra] extends [never] ? true : Extra = true;
const argsFit: [
  ArgOf<'pause'> extends CommandMeta ? true : false,
  ArgOf<'resume'> extends CommandMeta ? true : false,
  ArgOf<'stop'> extends CommandMeta ? true : false,
  ArgOf<'reroute'> extends RerouteCommand ? true : false,
  ArgOf<'answer'> extends AnswerCommand ? true : false,
  ArgOf<'agentEvent'> extends AgentEventCommand ? true : false,
] = [true, true, true, true, true, true];
// 引擎先收、后端还没发的（人闸）：后端加进 TaskSignal 的那天这里编译报错，提醒把名字挪进 TASK_SIGNAL_NAMES、补上参数对拍。
type AlreadySent = Extract<(typeof NEW_TASK_SIGNAL_NAMES)[number], ApiName>;
const noneSentYet: [AlreadySent] extends [never] ? true : AlreadySent = true;

describe('fleet 通行证', () => {
  it('引擎签的，后端验得过：任务、子任务、这一次会话都对得上，寿命在后端认的上限里', () => {
    const secret = 'k'.repeat(40);
    const sign = agentTokenSignerFromEnv({ FLEET_AGENT_TOKEN_SECRET: secret });
    expect(sign).not.toBeNull();
    const ttlSeconds = agentTokenTtlSeconds(90);
    expect(ttlSeconds).toBeLessThanOrEqual(AGENT_TOKEN_MAX_TTL_SECONDS);
    const token = sign?.({ taskId: 'task-1', subtaskId: 'sub-1', runId: 'run-1', ttlSeconds }) ?? '';
    const check = verifyAgentToken(secret, token, new Date());
    expect(check).toMatchObject({
      ok: true,
      claims: { taskId: 'task-1', subtaskId: 'sub-1', runId: 'run-1' },
    });
    expect(verifyAgentToken('x'.repeat(40), token, new Date()).ok).toBe(false);
  });

  it('没配钥匙就不签（假实现联调时才用占位的）', () => {
    expect(agentTokenSignerFromEnv({})).toBeNull();
  });
});

describe('后端发来的信号', { timeout: 60_000 }, () => {
  const currentEnv = useEnv();
  let env: TestWorkflowEnvironment;
  beforeEach(() => {
    env = currentEnv();
  });

  it('编译期对上了名字和参数', () => {
    expect([noneMissing, noneExtra, noneSentYet, ...argsFit]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('用后端真的发信号代码发：暂停、换路由、叫醒、回答、继续、叫停，引擎都收得到、有回执', async () => {
    const world = createFakeWorld({
      // 两次写码会话都挂住：叫停时子任务正停在「等会话」上。可跳时间的测试服务端取消「已排队、还没开始」的活动会报
      // ACTIVITY_UNKNOWN、把工作流任务卡死（真服务端没有这个问题），所以别在活动刚排上队的那一瞬间叫停。
      session: (input, n) => (input.stage === 'execute' && n <= 2 ? { hold: true } : {}),
    });
    const input = requirementInput();
    const control = createTemporalWorkflowControl(env.client, {
      workflowIdForTask: () => requirementWorkflowId(input.repo, input.issueNumber),
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await env.client.workflow.start(WORKFLOW_TYPES.requirement, {
        taskQueue: q,
        workflowId: requirementWorkflowId(input.repo, input.issueNumber),
        args: [input],
      });
      await waitUntil(() => world.held().length === 1, '写码会话挂着');
      const running = await queryUntil<RequirementStatus>(
        handle,
        (s) => Boolean(s.subtasks[0]?.workflowId),
        '子任务在写码',
      );
      const sub = running.subtasks[0];
      const child = env.client.workflow.getHandle(sub?.workflowId ?? '');
      const writing = await queryUntil<SubtaskStatus>(child, (s) => Boolean(s.runId), '子任务报上了会话');

      // 叫醒按会话发给所属的工作流（后端要改的就是这一处的编号）：子任务的会话发 sub:<subtask_id>。
      const wake = createTemporalWorkflowControl(env.client, {
        workflowIdForTask: () => subtaskWorkflowId(sub?.id ?? ''),
      });
      await wake.signal(input.taskId, {
        name: 'agentEvent',
        runId: writing.runId ?? '',
        kind: 'ask',
        askId: 'ask-1',
      });
      await queryUntil<SubtaskStatus>(
        child,
        (s) => s.lastAgentEvent?.kind === 'ask',
        '子任务收到 agentEvent',
      );

      await control.signal(input.taskId, { name: 'pause', by: 'founder', reason: '先停一下' });
      await queryUntil<SubtaskStatus>(child, (s) => s.paused && s.waiting?.kind === 'human', '子任务暂停');

      await control.signal(input.taskId, {
        name: 'reroute',
        by: 'founder',
        routeId: 'r3',
        subtaskId: sub?.id ?? '',
      });
      await control.signal(input.taskId, {
        name: 'answer',
        by: 'founder',
        askId: 'ask-nobody',
        answer: '好',
      });
      await control.signal(input.taskId, { name: 'resume', by: 'founder' });
      await waitUntil(() => world.held().length === 1 && world.held()[0]?.n === 2, '按新路由接着写');
      const receipts = ((await handle.query('status')) as RequirementStatus).commands;
      await control.signal(input.taskId, { name: 'stop', by: 'founder', reason: '不做了' });
      return { receipts, final: (await handle.result()) as RequirementResult };
    });
    expect(result.receipts.map((r) => [r.command, r.accepted, r.by])).toEqual([
      ['pause', true, 'founder'],
      ['reroute', true, 'founder'],
      ['answer', true, 'founder'],
      ['resume', true, 'founder'],
    ]);
    const execs = world.callsOf('startSession').filter((c) => c.input.stage === 'execute');
    expect(execs.map((c) => c.input.route.routeId)).toEqual(['r1', 'r3']);
    expect(result.final.state).toBe('stopped');
  });
});
