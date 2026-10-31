// Claude Code 壳（经 reclaude，原样转给 claude）的无头参数，从旧 adapters/src/claude-code/args.ts 复制改写。
// 提示词不进参数、走 stdin：超长会 E2BIG，而且 --allowedTools 吃变长参数，放在它后面的提示词会被当成工具名（已实测）。
import { fileURLToPath } from 'node:url';

export const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** new = 用我们给的会话号开新会话（进程没起来也知道该续哪个）；resume = 续这个会话，init 帧对不上判冲突（A3）。 */
export type ClaudeSession = { mode: 'new'; id: string } | { mode: 'resume'; id: string };

export interface ClaudeArgsSpec {
  /** 具体模型 id（例如 claude-opus-5-5）：别名核对不了实际模型。 */
  model: string;
  session: ClaudeSession;
  /** 没有默认值：放开权限必须是显式决定，前提是工人用户读不到任何凭据（env.ts、影子自检）。 */
  permissionMode: ClaudePermissionMode;
  /** writeMcpConfig 写出的文件；令牌不进命令行。 */
  mcpConfigPath: string;
  /** 调工具前那条钩子的脚本，默认仓里那份；只有测试改它。 */
  pretoolScript?: string;
}

/** 调工具前那条钩子：仓里这一份，和内核同一版，工人改不了（法国上在 releases 目录下归 root）。 */
export const PRETOOL_SCRIPT = fileURLToPath(new URL('../../../agents/hooks/pretool.mjs', import.meta.url));
const PRETOOL_MATCHER = 'Bash|PowerShell|Read|Grep';
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** 钩子退出码 2 = 拦下；别的非 0 Claude 当「钩子出错」照样放行，没人看着等于没装：一律改成 2（按拦处理）。 */
export function pretoolSettings(script: string = PRETOOL_SCRIPT, node: string = process.execPath): string {
  const command = `${shellQuote(node)} ${shellQuote(script)} || { c=$?; [ "$c" = 2 ] || echo "fleet-guard：调工具前的钩子没跑成（退出码 $c），按拦处理" >&2; exit 2; }`;
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: PRETOOL_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] }] },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:=,[\]-]*$/;

export function buildClaudeArgs(spec: ClaudeArgsSpec): string[] {
  if (!MODEL.test(spec.model)) throw new Error(`模型名不合法：${JSON.stringify(spec.model)}`);
  if (!UUID.test(spec.session.id)) throw new Error(`会话号必须是 UUID：${JSON.stringify(spec.session.id)}`);
  return [
    '-p',
    '--output-format',
    'stream-json',
    // -p 配 stream-json 不带 --verbose 会直接退出 1
    '--verbose',
    '--model',
    spec.model,
    // 只读项目级设置：不跑用户级 hooks；调工具前那条钩子另经 --settings 带上
    '--setting-sources',
    'project',
    '--settings',
    pretoolSettings(spec.pretoolScript),
    // 只挂内核给的 MCP，不读工人家里登记的
    '--strict-mcp-config',
    '--mcp-config',
    spec.mcpConfigPath,
    '--permission-mode',
    spec.permissionMode,
    // 无头会话没人答权限弹窗：要批准的一律当场拒，不挂着等
    '--permission-prompts',
    'none',
    ...(spec.session.mode === 'new' ? ['--session-id', spec.session.id] : ['--resume', spec.session.id]),
  ];
}
