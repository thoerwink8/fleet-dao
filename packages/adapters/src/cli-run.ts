// 起一个「stdout 一行一帧」的无头命令行执行体：各家命令行插头共用的起停与回调管道。
// 解析归各家的读取器；这里只管起进程、逐行交给读取器、按它的判断保活或强杀、把事件和额度读数交给调用方。

import { stat } from 'node:fs/promises';
import type { ProgressEvent } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { DetachedIo } from './detached.ts';
import {
  type AgentProcessResult,
  assertNotRealAgentInTests,
  DEFAULT_PROCESS_LIMITS,
  guardCallback,
  type ProcessControl,
  type ProcessLimits,
  runAgentProcess,
  type SpawnInfo,
} from './process.ts';
import type { CgroupScope } from './procs.ts';
import type { RateLimitReading } from './types.ts';

/** 读一行带来的变化。 */
export interface LineEffect {
  events: ProgressEvent[];
  /** 这一行说明会话在干活（模型在说、在想、工具在跑）；停滞计时从这里重来。 */
  activity: boolean;
  rateLimit?: RateLimitReading;
}

/** 一个事件出自输出的哪一行：seq 从 0 起；replay = 重读的、上一个引擎已经处理过的行（只重建状态，别再写库）。 */
export interface LineMeta {
  seq: number;
  replay: boolean;
}

/** 各家插头的公共选项（和 Claude 插头同一套）。 */
export interface AgentRunOptions {
  /** 起执行体的命令，给绝对路径。没有默认值：谁要起真执行体谁显式给，测试里换成假执行体。 */
  command: readonly string[];
  /** 可以是 async 的：被拒不会炸进程，记进 hookError；交报告之前会等它们落定。 */
  onEvent?: (event: ProgressEvent, meta: LineMeta) => unknown;
  onRateLimit?: (reading: RateLimitReading) => unknown;
  /** 进程起来了：引擎记下进程号和 scope，重启后用 reapSession 收旧会话。 */
  onSpawn?: (info: SpawnInfo) => unknown;
  signal?: AbortSignal;
  now?: () => Date;
  /** 走文件、不接管道（会话脱开引擎进程）；attach = 引擎重启后接回。 */
  io?: DetachedIo;
  /**
   * 接回时：序号小于它的行上一个引擎已经处理过（进度已进库）——照样交给读取器重建状态、事件照样给（meta.replay），
   * 但不保活、不核对、不报额度读数。
   */
  replayUntil?: number;
}

export interface CliRunPlan<E extends LineEffect> {
  runId: string;
  cwd: string;
  /** 接在 options.command 后面的参数。 */
  args: readonly string[];
  env: Record<string, string>;
  stdin: string;
  limits?: Partial<ProcessLimits> | undefined;
  cgroup?: CgroupScope | undefined;
  read(line: string): E;
  /** 有工具正在跑：这段时间不算停滞。 */
  busy(): boolean;
  /** 读完一行后按这家的规矩核对（会话号、模型、版本），不符就 control.kill。 */
  inspect?(effect: E, control: ProcessControl): void;
  /** 进程结束后读取器手里还攒着的事件（例如按增量拼的最后一句话）。 */
  drain?(): ProgressEvent[];
}

/** 起会话前的公共检查：测试里不许起真执行体、提示词不空、工作目录在。 */
export async function assertRunnable(command: readonly string[], prompt: string, cwd: string): Promise<void> {
  assertNotRealAgentInTests(command);
  if (!prompt.trim()) throw new Error('提示词是空的');
  const dir = await stat(cwd).catch(() => undefined);
  if (!dir?.isDirectory()) throw new Error(`工作目录不存在：${cwd}`);
}

/** 回调可以是 async 的：被拒记下第一条原因，交报告前等它们落定。 */
export class CallbackGate {
  #error: string | undefined;
  readonly #pending = new Set<Promise<unknown>>();

  call(fn: () => unknown): void {
    const settling = guardCallback(fn, (err) => {
      this.#error ??= errMessage(err);
    });
    if (settling) {
      this.#pending.add(settling);
      void settling.finally(() => this.#pending.delete(settling));
    }
  }

  /** 等所有回调落定，返回第一条异常。 */
  async settle(): Promise<string | undefined> {
    await Promise.allSettled([...this.#pending]);
    return this.#error;
  }
}

export async function runCliAgent<E extends LineEffect>(
  plan: CliRunPlan<E>,
  options: AgentRunOptions,
): Promise<AgentProcessResult> {
  const gate = new CallbackGate();
  let lastSeq = -1;
  const result = await runAgentProcess(
    {
      command: [...options.command, ...plan.args],
      cwd: plan.cwd,
      env: plan.env,
      stdin: plan.stdin,
      limits: { ...DEFAULT_PROCESS_LIMITS, ...plan.limits },
      runId: plan.runId,
      ...(plan.cgroup ? { scope: plan.cgroup } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.io ? { io: options.io } : {}),
    },
    {
      onLine(line, control) {
        const effect = plan.read(line);
        const meta: LineMeta = { seq: control.seq, replay: control.seq < (options.replayUntil ?? 0) };
        lastSeq = meta.seq;
        if (!meta.replay) {
          if (effect.activity) control.touch();
          plan.inspect?.(effect, control);
        }
        for (const event of effect.events) gate.call(() => options.onEvent?.(event, meta));
        const reading = effect.rateLimit;
        if (reading && !meta.replay) gate.call(() => options.onRateLimit?.(reading));
      },
      busy: () => plan.busy(),
      onSpawn: (info) => gate.call(() => options.onSpawn?.(info)),
    },
    options.now ?? (() => new Date()),
  );
  // 收场时读取器攒着的最后几条：算在最后一行之后的「虚一行」上，接回时照序号去重（上一个引擎确认过它就是重放）
  const tailSeq = lastSeq + 1;
  const tailMeta: LineMeta = { seq: tailSeq, replay: tailSeq < (options.replayUntil ?? 0) };
  for (const event of plan.drain?.() ?? []) gate.call(() => options.onEvent?.(event, tailMeta));
  const callbackError = await gate.settle();
  const hookError = result.hookError ?? callbackError;
  return { ...result, ...(hookError === undefined ? {} : { hookError }) };
}
