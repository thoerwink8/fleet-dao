// 在工人的工作目录里跑一条命令（git 探测、检查命令），所有子进程只经 harness-runner 的 runProcess（A5）。
// runProcess 按行判帧、起步看实质事件，这里把每一行输出都当进度（命令不是模型，没有“Syncing config…”这种空转）。
// 环境走工人环境白名单：检查命令跑的是工人写的代码，不能带宿主的任何凭据（H1）。
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { type Frame, type Redactor, runProcess } from '@fleet-dao/harness-runner';
import { buildWorkerEnv } from '@fleet-dao/harness-workers';

const EVERY_LINE_IS_PROGRESS = (): Frame => ({
  kind: 'assistant',
  substantive: true,
  toolsOpened: 0,
  toolsClosed: 0,
  step: '命令输出',
});

export interface CommandSpec {
  /** 可执行文件加参数，不经 shell。 */
  command: readonly string[];
  cwd: string;
  timeoutMs: number;
  hostEnv?: Readonly<Record<string, string | undefined>>;
  redact: Redactor;
  signal?: AbortSignal;
  /** stdout 最多留多少字符，超了截断并标 truncated。 */
  maxOutputChars?: number;
  /** 额外的环境变量（例如 GIT_INDEX_FILE）；同样过工人环境的禁表。 */
  env?: Readonly<Record<string, string>>;
}

export interface CommandResult {
  /** 命令自己跑完了（起来了、没被杀、有退出码）；false 就是这次没查成，调用方按 unknown 处理。 */
  ran: boolean;
  exitCode: number | null;
  killed?: string;
  spawnError?: string;
  stdout: string;
  truncated: boolean;
  stderrTail: string;
  wallMs: number;
}

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const cap = spec.maxOutputChars ?? 1_000_000;
  const out: string[] = [];
  let size = 0;
  let truncated = false;
  const runId = `cmd-${randomUUID()}`;
  const result = await runProcess(
    {
      command: [...spec.command],
      cwd: spec.cwd,
      env: buildWorkerEnv({
        base: spec.hostEnv ?? process.env,
        tmpDir: tmpdir(),
        extra: { ...spec.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      }),
      stdin: '',
      runId,
      // 起步时限比总时限长一点：命令不出声也不算“无进展”，到点只以总时限为准
      budget: { startupMs: spec.timeoutMs + 1_000, totalMs: spec.timeoutMs, killGraceMs: 2_000 },
      deadline: new Date(Date.now() + spec.timeoutMs),
      classify: EVERY_LINE_IS_PROGRESS,
      redact: spec.redact,
      ...(spec.signal ? { signal: spec.signal } : {}),
    },
    {
      onFrame(_frame, line) {
        if (size >= cap) {
          truncated = true;
          return;
        }
        out.push(line);
        size += line.length + 1;
      },
    },
  );
  const ran = result.exitCode !== null && !result.killed && !result.spawnError;
  return {
    ran,
    exitCode: result.exitCode,
    ...(result.killed ? { killed: `${result.killed.reason}：${result.killed.detail}` } : {}),
    ...(result.spawnError ? { spawnError: result.spawnError } : {}),
    stdout: out.join('\n'),
    truncated,
    stderrTail: result.stderrTail.slice(-1024),
    wallMs: result.wallMs,
  };
}
