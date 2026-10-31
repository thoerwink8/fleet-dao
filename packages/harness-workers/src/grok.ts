// Grok 命令行壳（#3842，Grok Build，SuperGrok 订阅）的无头参数和每轮的配置目录，从旧 adapters/src/grok/args.ts 复制改写。
// - 提示词写进工人临时目录里的文件，经 --prompt-file 读：Node 给子进程的 stdin 是 socketpair，grok 读 /dev/stdin 报 ENXIO
//   （旧引擎法国实测），旧引擎靠前面垫 cat 绕；写文件更简单，临时目录跑完整个删；
// - MCP 只能写进 config.toml（grok 没有 --mcp-config 旗标）：每轮把 GROK_HOME 指到临时目录下的 grok-home，
//   里面一份 0600 的 config.toml 只挂内核的 MCP，令牌照旧不进命令行；登录态用 GROK_AUTH_PATH 指回会话用户家里那份；
// - 旗标都在前面、不用子命令；免确认用 --always-approve；总带 --no-plan（计划模式要人批，无人值守会卡）；
// - 新会话用我们起的 UUID（-s），终帧 end.sessionId 回的就是它（A3 照样对账）。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudePermissionMode, ClaudeSession } from './claude-code.ts';
import { MCP_SERVER_NAME, type McpEndpoint, SESSION_TOKEN_HEADER } from './mcp-config.ts';

/** 写码用不上的内置工具：工具定义每次调用都重带一遍，关掉省 token（名单同旧引擎 GROK_DISALLOWED_TOOLS）。 */
export const GROK_DISALLOWED_TOOLS: readonly string[] = [
  'image_gen',
  'image_edit',
  'image_to_video',
  'reference_to_video',
  'send_feedback',
  'workflow',
  'scheduler_create',
  'scheduler_list',
  'scheduler_delete',
];

/**
 * 无人值守必带的环境：不自己升级（会话半路换二进制）、新目录不弹「信不信这个目录」、不反问没人答的选择题
 * （`--always-approve` 管不到后两样，同旧引擎 GROK_UNATTENDED_ENV）。
 */
export const GROK_UNATTENDED_ENV: Readonly<Record<string, string>> = {
  GROK_DISABLE_AUTOUPDATER: '1',
  GROK_FOLDER_TRUST: '0',
  GROK_ASK_USER_QUESTION: '0',
};

export interface GrokArgsSpec {
  /** 模型 id（例如 grok-4.7）；终帧回的是 grok-4.7-build 这种带后缀的。 */
  model: string;
  session: ClaudeSession;
  /** bypassPermissions 才带 --always-approve；别的档 grok 没有对应，按不放开处理。 */
  permissionMode: ClaudePermissionMode;
  cwd: string;
  promptFile: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function buildGrokArgs(spec: GrokArgsSpec): string[] {
  if (!MODEL.test(spec.model)) throw new Error(`模型名不合法：${JSON.stringify(spec.model)}`);
  if (!UUID.test(spec.session.id)) throw new Error(`会话号必须是 UUID：${JSON.stringify(spec.session.id)}`);
  if (!spec.cwd) throw new Error('没给工作目录');
  return [
    '--prompt-file',
    spec.promptFile,
    '--output-format',
    'streaming-json',
    ...(spec.permissionMode === 'bypassPermissions' ? ['--always-approve'] : []),
    '--no-plan',
    '--disallowed-tools',
    GROK_DISALLOWED_TOOLS.join(','),
    '-m',
    spec.model,
    '--cwd',
    spec.cwd,
    spec.session.mode === 'new' ? '-s' : '-r',
    spec.session.id,
  ];
}

const tomlString = (s: string) => JSON.stringify(s);

/** grok 的 config.toml：只挂内核的 MCP（Streamable HTTP，令牌走请求头）。 */
export function grokConfigToml(endpoint: McpEndpoint): string {
  const u = new URL(endpoint.url);
  if (u.search) throw new Error('MCP 地址里不许带查询参数：令牌只走请求头');
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `url = ${tomlString(endpoint.url)}`,
    `headers = { ${tomlString(SESSION_TOKEN_HEADER)} = ${tomlString(endpoint.token)} }`,
    '',
  ].join('\n');
}

export interface GrokHome {
  /** 这一轮的 GROK_HOME。 */
  home: string;
  promptFile: string;
}

/** 在工人自己的临时目录里写这一轮的 grok-home/config.toml 和提示词文件（都 0600，交给会话用户之前写）。 */
export async function writeGrokHome(dir: string, endpoint: McpEndpoint, prompt: string): Promise<GrokHome> {
  const home = join(dir, 'grok-home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, 'config.toml'), grokConfigToml(endpoint), { mode: 0o600, flag: 'wx' });
  const promptFile = join(dir, 'prompt.md');
  await writeFile(promptFile, prompt, { mode: 0o600, flag: 'wx' });
  return { home, promptFile };
}

/** 这一轮给 grok 的环境：无人值守那几样 + GROK_HOME 指到临时目录 + 登录态文件。 */
export function grokEnv(home: string, authPath: string): Record<string, string> {
  if (!authPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(authPath)) {
    throw new Error(`grok 登录态文件要写绝对路径：${authPath}`);
  }
  return { ...GROK_UNATTENDED_ENV, GROK_HOME: home, GROK_AUTH_PATH: authPath };
}
