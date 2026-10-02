// 和驾驶舱后端（packages/api）的约定：两边各写各的，这里拿后端真的代码来对。
// 1. fleet 通行证：引擎签，后端验，两边得是一回事。
// 2. 信号：后端按 TaskSignal 发（信号名 = name，参数 = 其余字段），引擎按同名同形收。
// #556-1：Fusion / 需求 / 子任务 / 合并队列工作流删了，原来端到端发信号那一条没法跑——等 555-2 有了新流程补。
import { AGENT_TOKEN_MAX_TTL_SECONDS, type TaskSignal, verifyAgentToken } from '@fleet-dao/api';
import { describe, expect, it } from 'vitest';
import { agentTokenTtlSeconds } from '../src/activities.ts';
import type {
  AgentEventCommand,
  AnswerCommand,
  CommandMeta,
  NEW_TASK_SIGNAL_NAMES,
  RequireApprovalCommand,
  RerouteCommand,
  TASK_SIGNAL_NAMES,
} from '../src/contract.ts';
import { agentTokenSignerFromEnv } from '../src/worker.ts';

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
  ArgOf<'requireApproval'> extends RequireApprovalCommand ? true : false,
] = [true, true, true, true, true, true, true];
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

describe('后端发来的信号（编译期对拍）', () => {
  it('名字和参数都对上了', () => {
    expect([noneMissing, noneExtra, noneSentYet, ...argsFit]).toEqual(Array(10).fill(true));
  });
});
