// Claude Code 工人槽位：起一轮工人，起止各记一条事件进 fleet2.events（流 worker:<runId>）。
// 会话号由我们给（new 模式），起之前就写进 worker.spawned：进程没起来、应答丢了也知道该续哪个会话（A3）。
// 影子模式先过自检，缺一不起（shadow.ts）。
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@fleet-dao/harness-contract';
import {
  BUDGETS,
  type Budget,
  deriveDeadline,
  makeRedactor,
  type RunResult,
  runProcess,
  secretsFromEnv,
} from '@fleet-dao/harness-runner';
import { appendEvents, type Db } from '@fleet-dao/harness-store';
import { buildClaudeArgs, type ClaudePermissionMode, type ClaudeSession } from './claude-code.ts';
import { buildWorkerEnv } from './env.ts';
import { type McpEndpoint, writeMcpConfig } from './mcp-config.ts';
import { type ShadowProbes, ShadowSelfCheckError, shadowSelfCheck } from './shadow.ts';

export interface WorkerTurn {
  db: Db;
  runId: string;
  /** 执行体命令前缀：生产是 reclaude 的绝对路径；测试换成假执行体。 */
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
  try {
    const mcpConfigPath = await writeMcpConfig(dir, turn.mcp);
    const env = buildWorkerEnv({
      base: host,
      tmpDir: dir,
      ...(turn.extraEnv ? { extra: turn.extraEnv } : {}),
    });
    const args = buildClaudeArgs({
      model: turn.model,
      session,
      permissionMode: turn.permissionMode,
      mcpConfigPath,
    });
    await appendEvents(turn.db, stream, 0, [
      {
        schemaVersion: SCHEMA_VERSION,
        type: 'worker.spawned',
        payload: {
          runId: turn.runId,
          sessionId: session.id,
          sessionMode: session.mode,
          model: turn.model,
          shadow: Boolean(turn.shadow),
          deadline: deadline.toISOString(),
        },
      },
    ]);
    const result = await runProcess({
      command: [...turn.command, ...args],
      cwd: turn.cwd,
      env,
      stdin: turn.prompt,
      runId: turn.runId,
      budget,
      deadline,
      expectSessionId: session.id,
      redact,
      ...(turn.signal ? { signal: turn.signal } : {}),
    });
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
          ...(result.spawnError ? { spawnError: result.spawnError } : {}),
        },
      },
    ]);
    return { sessionId: session.id, result };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
