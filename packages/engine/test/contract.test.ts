// 和驾驶舱后端（packages/api）的约定：两边各写各的，这里拿后端真的代码来对。
// 信号：后端按 TaskSignal 发（信号名 = name，参数 = 其余字段），引擎按同名同形收。
// #556-2：fleet 通行证（引擎签、后端验）随旧会话的 startSession 删了。
// #556-1：Fusion / 需求 / 子任务 / 合并队列工作流删了，原来端到端发信号那一条没法跑——等 555-2 有了新流程补。
import type { TaskSignal } from '@fleet-dao/api';
import { describe, expect, it } from 'vitest';
import type {
  AgentEventCommand,
  AnswerCommand,
  CommandMeta,
  NEW_TASK_SIGNAL_NAMES,
  RequireApprovalCommand,
  RerouteCommand,
  TASK_SIGNAL_NAMES,
} from '../src/contract.ts';

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

describe('后端发来的信号（编译期对拍）', () => {
  it('名字和参数都对上了', () => {
    expect([noneMissing, noneExtra, noneSentYet, ...argsFit]).toEqual(Array(10).fill(true));
  });
});
