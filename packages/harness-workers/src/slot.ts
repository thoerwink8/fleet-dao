// 工人槽位：起一轮工人（Claude Code，或按 shell 换 Grok 命令行，#3842），起止各记一条事件进 fleet2.events（流 worker:<runId>）。
// 会话号由我们给（new 模式），起之前就写进 worker.spawned：进程没起来、应答丢了也知道该续哪个会话（A3）。
// 影子模式先过自检，缺一不起（shadow.ts）。
// 给了 sandbox（法国：工人以会话用户跑）：临时目录写完 MCP 配置交给会话用户，跑完先收 scope 再按回执删，
// 结局记 worker.cleaned；收不干净不抛（结局已经记了），只照实记。
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@fleet-dao/harness-contract';
import {
  BUDGETS,
  type Budget,
  classifyGrokLine,
  deriveDeadline,
  makeRedactor,
  type Redactor,
  type RunResult,
  runProcess,
  secretsFromEnv,
} from '@fleet-dao/harness-runner';
import { appendEvents, type Db } from '@fleet-dao/harness-store';
import { buildClaudeArgs, type ClaudePermissionMode, type ClaudeSession } from './claude-code.ts';
import { buildWorkerEnv } from './env.ts';
import { buildGrokArgs, grokEnv, writeGrokHome } from './grok.ts';
import { type McpEndpoint, writeMcpConfig } from './mcp-config.ts';
import type { AdoptedDir, WorkerSandbox } from './sandbox.ts';
import { type ShadowProbes, ShadowSelfCheckError, shadowSelfCheck } from './shadow.ts';
import { GrokTranscriptParser, type TranscriptSummary, TranscriptWriter } from './transcript.ts';

/** 工人用哪个壳（#3842）：Claude Code 经 reclaude，或 Grok 命令行。 */
export const WORKER_SHELLS = ['claude-code', 'grok'] as const;
export type WorkerShell = (typeof WORKER_SHELLS)[number];

export interface WorkerTurn {
  db: Db;
  runId: string;
  /** 不给是 claude-code。 */
  shell?: WorkerShell;
  /** shell=grok 必给：grok 登录态文件（会话用户家里的 ~/.grok/auth.json）的绝对路径。 */
  grokAuthPath?: string;
  /** 执行体命令前缀：生产是执行体前缀加 reclaude 或 grok 的绝对路径；测试换成假执行体。 */
  command: readonly string[];
  model: string;
  permissionMode: ClaudePermissionMode;
  prompt: string;
  cwd: string;
  mcp: McpEndpoint;
  /** 续会话时给上一轮的会话号；不给就新开一个。 */
  resumeSessionId?: string;
  /** 上层的绝对截止时刻；不给就按预算表从现在算。 */
  parentDeadline?: Date;
  budget?: Budget;
  /** 给了就是影子：自检过了才起。 */
  shadow?: ShadowProbes;
  /** 宿主环境（只抄白名单），默认 process.env。 */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /** 额外的环境变量（测试给假执行体的开关）。 */
  extraEnv?: Readonly<Record<string, string>>;
  tmpRoot?: string;
  /** 工人以会话用户跑（法国）：交目录、收 scope。不给就是工人和内核同一个用户（本机、CI）。 */
  sandbox?: WorkerSandbox;
  signal?: AbortSignal;
}

export interface WorkerTurnResult {
  sessionId: string;
  result: RunResult;
}

export async function runClaudeWorker(turn: WorkerTurn): Promise<WorkerTurnResult> {
  if (turn.shadow) {
    const check = await shadowSelfCheck(turn.shadow);
    if (!check.ok) throw new ShadowSelfCheckError(check.why);
  }
  const budget = turn.budget ?? BUDGETS.workerTurn;
  const deadline = deriveDeadline(new Date(), budget, turn.parentDeadline);
  const session: ClaudeSession = turn.resumeSessionId
    ? { mode: 'resume', id: turn.resumeSessionId }
    : { mode: 'new', id: randomUUID() };
  const host = turn.hostEnv ?? process.env;
  const redact = makeRedactor([turn.mcp.token, ...secretsFromEnv(host)]);
  const stream = `worker:${turn.runId}`;
  const dir = await mkdtemp(join(turn.tmpRoot ?? tmpdir(), 'fleet2-worker-'));
  let written = 0;
  let adopted: AdoptedDir | undefined;
  const shell = turn.shell ?? 'claude-code';
  try {
    // 两个壳各自的配置都在交给会话用户之前写进临时目录（0600），令牌不进命令行
    let args: string[];
    let shellEnv: Record<string, string> = {};
    let stdin = turn.prompt;
    if (shell === 'grok') {
      if (!turn.grokAuthPath) throw new Error('shell=grok 要给 grokAuthPath（grok 登录态文件的绝对路径）');
      const g = await writeGrokHome(dir, turn.mcp, turn.prompt);
      shellEnv = grokEnv(g.home, turn.grokAuthPath);
      args = buildGrokArgs({
        model: turn.model,
        session,
        permissionMode: turn.permissionMode,
        cwd: turn.cwd,
        promptFile: g.promptFile,
      });
      stdin = '';
    } else {
      const mcpConfigPath = await writeMcpConfig(dir, turn.mcp);
      args = buildClaudeArgs({
        model: turn.model,
        session,
        permissionMode: turn.permissionMode,
        mcpConfigPath,
      });
    }
    if (turn.sandbox) adopted = await turn.sandbox.adopt(dir);
    const env = buildWorkerEnv({
      base: host,
      tmpDir: dir,
      extra: { ...shellEnv, ...(turn.extraEnv ?? {}) },
    });
    await appendEvents(turn.db, stream, 0, [
      {
        schemaVersion: SCHEMA_VERSION,
        type: 'worker.spawned',
        payload: {
          runId: turn.runId,
          sessionId: session.id,
          sessionMode: session.mode,
          shell,
          model: turn.model,
          shadow: Boolean(turn.shadow),
          deadline: deadline.toISOString(),
        },
      },
    ]);
    written = 1;
    // 过程落库（#3781）：stdout 每一行拆成事件，攒一批写一次；子进程被杀、超时也走到下面的 close，把攒着的写掉
    const transcript = new TranscriptWriter({
      db: turn.db,
      runId: turn.runId,
      redact,
      ...(shell === 'grok' ? { parser: new GrokTranscriptParser(turn.runId, redact) } : {}),
    });
    let result: RunResult;
    let transcriptSummary: TranscriptSummary;
    try {
      result = await runProcess(
        {
          command: [...turn.command, ...args],
          cwd: turn.cwd,
          env,
          stdin,
          runId: turn.runId,
          budget,
          deadline,
          expectSessionId: session.id,
          ...(shell === 'grok' ? { classify: classifyGrokLine } : {}),
          redact,
          ...(turn.signal ? { signal: turn.signal } : {}),
        },
        { onFrame: (_frame, line) => transcript.pushLine(line) },
      );
    } finally {
      transcriptSummary = await transcript.close();
    }
    await appendEvents(turn.db, stream, 1, [
      {
        schemaVersion: SCHEMA_VERSION,
        type: 'worker.settled',
        payload: {
          runId: turn.runId,
          sessionId: result.sessionId ?? session.id,
          exitCode: result.exitCode,
          signal: result.signal,
          killed: result.killed ?? null,
          lastStep: result.lastStep,
          firstProgressMs: result.firstProgressMs ?? null,
          wallMs: result.wallMs,
          stragglers: result.stragglers,
          leftovers: result.leftovers ?? null,
          stderrTail: result.stderrTail.slice(-4096),
          transcript: transcriptSummary,
          ...(result.spawnError ? { spawnError: result.spawnError } : {}),
        },
      },
    ]);
    written = 2;
    return { sessionId: session.id, result };
  } finally {
    if (turn.sandbox) await cleanSandboxed(turn, turn.sandbox, dir, adopted, written, redact);
    else await rm(dir, { recursive: true, force: true });
  }
}

async function cleanSandboxed(
  turn: WorkerTurn,
  sandbox: WorkerSandbox,
  dir: string,
  adopted: AdoptedDir | undefined,
  written: number,
  redact: Redactor,
): Promise<void> {
  const errors: string[] = [];
  const why = (e: unknown) => redact(e instanceof Error ? e.message : String(e)).slice(0, 1000);
  try {
    await sandbox.stop(turn.runId);
  } catch (e) {
    errors.push(`收 scope：${why(e)}`);
  }
  try {
    // 没交出去（交的时候就失败了）的目录还归自己，自己删
    if (adopted) await adopted.release();
    else await rm(dir, { recursive: true, force: true });
  } catch (e) {
    errors.push(`删临时目录：${why(e)}`);
  }
  // 起进程之前就失败了的（没记 worker.spawned），流里一条都不写：和不给 sandbox 时一样
  if (written === 0) return;
  await appendEvents(turn.db, `worker:${turn.runId}`, written, [
    {
      schemaVersion: SCHEMA_VERSION,
      type: 'worker.cleaned',
      payload: { runId: turn.runId, ok: errors.length === 0, errors },
    },
  ]);
}
