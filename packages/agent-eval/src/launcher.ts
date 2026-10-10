// 起无头会话。命令和本机工人起 Claude 的是同一个：agents/skills/commander/scripts/worker-lib.mjs 的 launchOf 里写的 `reclaude`
// （Claude 一律经 reclaude 起，通用段）；test/launcher.test.ts 钉着两边相等。AGENT_EVAL_CLAUDE 可以换命令名（只给没装 reclaude 的机器）。
// 没有限回合的参数：`claude --help` 里没有 --max-turns 一类（2026-10-09 核过），回合上限只能靠 10 分钟限时；
// 定义里的 maxTurns 照样记进结果，不假装限住了。
import { spawn, spawnSync } from 'node:child_process';
import type { AgentDefinition } from './definitions.ts';
import { allowedToolsOf } from './definitions.ts';

export const CLAUDE_COMMAND = 'reclaude';
export const SESSION_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_TURNS = 40;

export const MODEL_IDS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
} as const;
export type ModelKey = keyof typeof MODEL_IDS;
export const MODEL_KEYS: readonly ModelKey[] = ['haiku', 'sonnet', 'opus'];
/** 裁判模型固定用 Sonnet 5.5。 */
export const JUDGE_MODEL_ID = MODEL_IDS.sonnet;

export function claudeCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_EVAL_CLAUDE?.trim() || CLAUDE_COMMAND;
}

export interface LaunchRequest {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
}

export interface LaunchResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 起不来（命令找不到、权限不够）的原因。 */
  spawnError?: string;
}

export type Launcher = (req: LaunchRequest) => Promise<LaunchResult>;

const COMMON_ARGS = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--setting-sources',
  'project',
  '--strict-mcp-config',
  '--permission-mode',
  'dontAsk',
];

/** 一道题里被测会话的参数：定义的工具（去掉 mcp__）、定义的正文当附加系统提示。提示词走 stdin，不在这里。 */
export function buildSessionArgs(def: AgentDefinition, modelId: string): string[] {
  return [
    '-p',
    '--model',
    modelId,
    ...COMMON_ARGS,
    '--allowedTools',
    allowedToolsOf(def).join(','),
    '--append-system-prompt',
    def.body,
  ];
}

/** 裁判会话的参数：不给任何工具（dontAsk 下一律拒），不带系统提示。 */
export function buildJudgeArgs(): string[] {
  return ['-p', '--model', JUDGE_MODEL_ID, ...COMMON_ARGS];
}

/** --dry-run 打印用：正文太长，换成字数。 */
export function displayArgs(args: string[]): string[] {
  const out = [...args];
  const i = out.indexOf('--append-system-prompt');
  if (i >= 0 && out[i + 1] !== undefined) out[i + 1] = `<定义正文 ${(out[i + 1] as string).length} 字>`;
  return out;
}

export const realLauncher: Launcher = (req) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: LaunchResult) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(req.command, req.args, {
        cwd: req.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut: false,
        spawnError: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      }
      child.kill('SIGKILL');
    }, req.timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.stdin?.on('error', () => {});
    child.on('error', (e) => finish({ exitCode: null, stdout, stderr, timedOut, spawnError: e.message }));
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr, timedOut }));
    child.stdin?.end(req.stdin);
  });
