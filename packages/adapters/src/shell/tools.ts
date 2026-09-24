// 接口外壳的三件工具：读文件、写文件、跑命令，只许碰工作树。
// 放进 scope 时（生产）三件都以会话专用用户的身份做：命令、读、写都经 fleet-agent-scope 起一个短命进程，
// 引擎用户自己不碰工作树里的文件——不然命令会以引擎的身份跑，读得到引擎的配置和凭据。
// 不放 scope 时（开发机、测试）在本进程里读写，路径按真实路径核对，符号链接也逃不出工作树。
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DEFAULT_PROCESS_LIMITS, runAgentProcess } from '../process.ts';
import type { CgroupScope } from '../procs.ts';
import type { ShellToolSpec } from './wire.ts';

export const SHELL_TOOLS: readonly ShellToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file in the working tree. Path is relative to the tree root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path, e.g. src/index.ts' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Write the full content of a file in the working tree (creates it and parent directories if missing, overwrites otherwise).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path' },
        content: { type: 'string', description: 'The complete new file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command (bash) in the working tree root. Returns the exit code and combined output. Long-running commands are killed at the timeout.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command line' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/** 三件工具真正落地的地方。测试里可以整个换掉。 */
export interface ShellHost {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  run(command: string): Promise<CommandResult>;
}

export interface HostOptions {
  /** 工作树（绝对路径）。 */
  cwd: string;
  runId: string;
  /** 命令的环境（已经滤过凭据的会话环境）。 */
  env: Record<string, string>;
  commandTimeoutMs: number;
  /** 给了就三件都经 fleet-agent-scope 以会话用户的身份做；每次一个 scope，编号是 <id>-<序号>。 */
  scope?: CgroupScope;
  /** 单次输出最多留多少字（留尾巴：报错一般在最后）。 */
  maxOutputChars: number;
}

/** 相对工作树的路径 → 绝对路径；出了工作树就抛。 */
export function insideTree(cwd: string, path: string): string {
  if (!path || path.includes('\0')) throw new Error('路径是空的');
  const full = resolve(cwd, path);
  const rel = relative(cwd, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`路径出了工作树：${path}`);
  return full;
}

async function assertRealInside(cwd: string, target: string): Promise<void> {
  const root = await realpath(cwd);
  const real = await realpath(target);
  const rel = relative(root, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('路径经符号链接出了工作树');
}

function tail(text: string, max: number): string {
  return text.length > max ? `…（前面省略 ${text.length - max} 字）\n${text.slice(-max)}` : text;
}

export function createHost(options: HostOptions): ShellHost {
  const { cwd, scope } = options;
  let seq = 0;
  const exec = async (command: string[], stdin: string, timeoutMs: number): Promise<CommandResult> => {
    seq++;
    const lines: string[] = [];
    const result = await runAgentProcess(
      {
        command,
        cwd,
        env: options.env,
        stdin,
        // 命令可以很久不出一行字（跑测试）：起步期限和总时长一样
        limits: {
          ...DEFAULT_PROCESS_LIMITS,
          startupMs: timeoutMs,
          wallClockMs: timeoutMs,
          killGraceMs: 2_000,
        },
        runId: `${options.runId}-t${seq}`,
        ...(scope ? { scope: { ...scope, id: `${scope.id}-${seq}`.slice(0, 63) } } : {}),
      },
      { onLine: (line) => void lines.push(line) },
    );
    if (result.spawnError) throw new Error(`命令没起来：${result.spawnError}`);
    const stderr = result.stderrTail.trim();
    return {
      exitCode: result.exitCode,
      output: [lines.join('\n'), stderr].filter((x) => x).join('\n'),
      timedOut: result.killed?.reason === 'wall_clock_timeout' || result.killed?.reason === 'startup_timeout',
    };
  };
  const bash = process.platform === 'win32' ? ['bash', '-c'] : ['/bin/bash', '-c'];

  if (scope) {
    return {
      async readFile(path) {
        const r = await exec(['/bin/cat', '--', insideTree(cwd, path)], '', 60_000);
        if (r.exitCode !== 0) throw new Error(tail(r.output, 500) || `读不了（退出码 ${r.exitCode}）`);
        return r.output;
      },
      async writeFile(path, content) {
        const full = insideTree(cwd, path);
        const r = await exec(
          ['/bin/sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', full],
          content,
          60_000,
        );
        if (r.exitCode !== 0) throw new Error(tail(r.output, 500) || `写不进去（退出码 ${r.exitCode}）`);
      },
      async run(command) {
        const r = await exec([...bash, command], '', options.commandTimeoutMs);
        return { ...r, output: tail(r.output, options.maxOutputChars) };
      },
    };
  }
  return {
    async readFile(path) {
      const full = insideTree(cwd, path);
      await assertRealInside(cwd, full);
      return readFile(full, 'utf8');
    },
    async writeFile(path, content) {
      const full = insideTree(cwd, path);
      await mkdir(dirname(full), { recursive: true });
      await assertRealInside(cwd, dirname(full));
      await writeFile(full, content);
    },
    async run(command) {
      const r = await exec([...bash, command], '', options.commandTimeoutMs);
      return { ...r, output: tail(r.output, options.maxOutputChars) };
    },
  };
}
