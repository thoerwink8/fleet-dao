// cursor-agent 插头：无头起一个会话（提示词走 stdin），过程记录转成进度事件，结束时交出一份报告。
// 用 --model auto 吃订阅里的 Auto 额度；花费不在流里（只认 Dashboard，CU-08），这里只报 token。
import { type AgentRunOptions, assertRunnable, runCliAgent } from '../cli-run.ts';
import { buildSessionEnv, type SessionEnvInput } from '../env.ts';
import type { RunFacts, RunSummary } from '../judge.ts';
import type { AgentProcessResult, ProcessLimits } from '../process.ts';
import type { CgroupScope } from '../procs.ts';
import { cut, lastLines, looksLikeQuotaExhausted } from '../stream-kit.ts';
import { buildCursorArgs, type CursorSession } from './args.ts';
import { CursorStreamReader, type CursorStreamSummary } from './stream.ts';

export interface CursorRunSpec {
  runId: string;
  /** 工作树。 */
  cwd: string;
  /** 走 stdin。 */
  prompt: string;
  model: string;
  session: CursorSession;
  /** 见 CursorArgsSpec.force。 */
  force: boolean;
  /**
   * cursor 的登录态在 HOME 下。进 scope 时要在会话用户家里登好——环境里的 key 进不去（见 scopeLaunch）；
   * 不进 scope（开发机）才能把 CURSOR_API_KEY 放进 env.extra。
   */
  env: SessionEnvInput;
  limits?: Partial<ProcessLimits>;
  testCommands?: readonly string[];
  cgroup?: CgroupScope;
}

export interface CursorRunReport extends AgentProcessResult {
  runId: string;
  requestedModel: string;
  session: CursorSession;
  stream: CursorStreamSummary;
}

export async function runCursorAgent(
  spec: CursorRunSpec,
  options: AgentRunOptions,
): Promise<CursorRunReport> {
  await assertRunnable(options.command, spec.prompt, spec.cwd);
  const args = buildCursorArgs({
    model: spec.model,
    session: spec.session,
    workspace: spec.cwd,
    force: spec.force,
  });
  const reader = new CursorStreamReader({
    runId: spec.runId,
    cwd: spec.cwd,
    ...(spec.testCommands ? { testCommands: spec.testCommands } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const resumeId = spec.session.mode === 'resume' ? spec.session.id : undefined;
  const result = await runCliAgent(
    {
      runId: spec.runId,
      cwd: spec.cwd,
      args,
      env: buildSessionEnv(spec.env),
      stdin: spec.prompt,
      limits: spec.limits,
      cgroup: spec.cgroup,
      read: (line) => reader.read(line),
      busy: () => reader.toolsInFlight > 0,
      inspect(effect, control) {
        if (resumeId && effect.init?.sessionId && effect.init.sessionId !== resumeId) {
          control.kill('session_mismatch');
        }
      },
    },
    options,
  );
  return {
    ...result,
    runId: spec.runId,
    requestedModel: spec.model,
    session: spec.session,
    stream: reader.summary(),
  };
}

export function cursorRunFacts(report: CursorRunReport): RunFacts {
  const r = report.stream.result;
  const words = lastLines(report.stderrTail);
  return {
    ...(report.spawnError ? { spawnError: report.spawnError } : {}),
    ...(report.killed ? { killed: report.killed.reason } : {}),
    exitCode: report.exitCode,
    signal: report.signal,
    ...(r
      ? {
          terminal: {
            isError: r.isError,
            detail: cut([r.subtype, r.text].filter((x) => x).join(' · '), 300),
          },
        }
      : {}),
    // 额度、认证、网络的报错都只在 stderr（退出 1、没有任何 JSON）
    quotaExhausted:
      looksLikeQuotaExhausted(words) || (r?.isError === true && looksLikeQuotaExhausted(r.text)),
    ...(words ? { lastWords: words } : {}),
  };
}

/** 交给引擎的统一摘要。流里没有实际模型（只有界面名），所以不带 actualModel。 */
export function cursorRunSummary(report: CursorRunReport): RunSummary {
  const usage = report.stream.result?.usage;
  return {
    facts: cursorRunFacts(report),
    ...(report.stream.sessionId ? { sessionId: report.stream.sessionId } : {}),
    // 字段同名：终帧里有哪些带哪些
    usage: { ...usage },
  };
}
