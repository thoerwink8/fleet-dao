// 起一个「stdout 一行一帧」的无头命令行执行体：各家命令行插头共用的起停与回调管道。
// 解析归各家的读取器；这里只管起进程、逐行交给读取器、按它的判断保活或强杀、把事件和额度读数交给调用方。
import { stat } from 'node:fs/promises';
import type { ProgressEvent } from '@fleet-dao/shared';
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

/** 各家插头的公共选项（和 Claude 插头同一套）。 */
export interface AgentRunOptions {
  /** 起执行体的命令，给绝对路径。没有默认值：谁要起真执行体谁显式给，测试里换成假执行体。 */
  command: readonly string[];
  /** 可以是 async 的：被拒不会炸进程，记进 hookError；交报告之前会等它们落定。 */
  onEvent?: (event: ProgressEvent) => unknown;
  onRateLimit?: (reading: RateLimitReading) => unknown;
  /** 进程起来了：引擎记下进程号和 scope，重启后用 reapSession 收旧会话。 */
  onSpawn?: (info: SpawnInfo) => unknown;
  signal?: AbortSignal;
  now?: () => Date;
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
      this.#error ??= err instanceof Error ? err.message : String(err);
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
    },
    {
      onLine(line, control) {
        const effect = plan.read(line);
        if (effect.activity) control.touch();
        plan.inspect?.(effect, control);
        for (const event of effect.events) gate.call(() => options.onEvent?.(event));
        const reading = effect.rateLimit;
        if (reading) gate.call(() => options.onRateLimit?.(reading));
      },
      busy: () => plan.busy(),
      onSpawn: (info) => gate.call(() => options.onSpawn?.(info)),
    },
    options.now ?? (() => new Date()),
  );
  for (const event of plan.drain?.() ?? []) gate.call(() => options.onEvent?.(event));
  const callbackError = await gate.settle();
  const hookError = result.hookError ?? callbackError;
  return { ...result, ...(hookError === undefined ? {} : { hookError }) };
}
