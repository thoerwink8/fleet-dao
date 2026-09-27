// cursor-agent 插头：无头起一个会话（提示词走 stdin），过程记录转成进度事件，结束时交出一份报告。
// 模型照路由上写的（auto = Cursor 自己挑，按它实际选中的模型扣订阅里包含的用量）；花费不在流里（只认 Dashboard，CU-08），
// 这里只报 token。开新会话的会话号是它自己在 init 帧里起的：报出来时调 onSessionId。
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
   * 认证：进 scope 时引擎这边环境里的 key 进不去（见 scopeLaunch）——法国的 API 密钥是会话用户家里的一个文件，由起它的命令
   * 以会话用户的身份读出来、放进环境再 exec（engine 的 cursorLaunchCommand），不经这里。不进 scope（开发机）可以把
   * CURSOR_API_KEY 放进 env.extra，或者用本机的登录态。
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

export interface CursorRunOptions extends AgentRunOptions {
  /**
   * init 帧报出会话号时调一次（续会话报的号对不上就不调，直接停掉）。开新会话的号 cursor 自己起、事先定不了，
   * 调用方在这里才知道真号。同步调：抛了记进报告的 hookError，解析照常往下走。
   */
  onSessionId?: (id: string) => void;
}

export async function runCursorAgent(
  spec: CursorRunSpec,
  options: CursorRunOptions,
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
        const id = effect.init?.sessionId;
        if (!id) return;
        if (resumeId && id !== resumeId) {
          control.kill('session_mismatch');
          return;
        }
        options.onSessionId?.(id);
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

/** 终端控制符（颜色这类）：有几句报错不管有没有终端都带颜色，比如「⚠ Warning: The provided API key is invalid.」。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要去掉终端控制符
const TERMINAL_CONTROL = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * 没信任过的工作目录、又没带 --trust / --force 时，-p 在 stderr 打一段提示就退出（2026.09.26 发行包里退出码是 1；不管是几，
 * 没有终帧都判没跑成）。最后几行只剩「怎么办」，认得出是这一种的只有开头那一句：单独捞出来接在最后几行前面（失败分流 CF1 认它）。
 */
const WORKSPACE_TRUST = /^.*Workspace Trust Required.*$/m;

/** stderr 的最后几行，去掉终端控制符；Workspace Trust 那段的开头一句挤出了最后几行的话另接上。 */
function cursorLastWords(stderrTail: string): string | undefined {
  const plain = stderrTail.replace(TERMINAL_CONTROL, '');
  const words = lastLines(plain);
  const trust = plain.match(WORKSPACE_TRUST)?.[0]?.trim();
  if (!trust || words?.includes(trust)) return words;
  return words ? cut(`${trust} ⏎ ${words}`, 600) : trust;
}

export function cursorRunFacts(report: CursorRunReport): RunFacts {
  const r = report.stream.result;
  const words = cursorLastWords(report.stderrTail);
  return {
    ...(report.spawnError ? { spawnError: report.spawnError } : {}),
    ...(report.killed ? { killed: report.killed.reason } : {}),
    exitCode: report.exitCode,
    ...(report.exitLost ? { exitLost: report.exitLost } : {}),
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
