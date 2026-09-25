// reclaude（原样转给 claude）的无头参数。提示词不进参数，走 stdin：超长会 E2BIG，而且 --allowedTools 吃变长参数，
// 放在它后面的提示词会被当成工具名（已实测）。
export const CLAUDE_PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * new = 用我们给的会话号开新会话（进程没起来也知道该续哪个）；resume = 续上这个会话；
 * fork = 带着 from 的全部记录开一个新会话 id（`--resume <from> --fork-session --session-id <id>`）——
 * 换会话用户接着干时用：原会话绑着旧账号，直接 --resume 会被拒，fork 出的新编号能续上（设计第九节）。
 * id 在三种模式下都是「这次实际要跑起来的会话号」：run.ts 核对 init 帧的 session_id 只认它。
 */
export type ClaudeSession =
  | { mode: 'new'; id: string }
  | { mode: 'resume'; id: string }
  | { mode: 'fork'; from: string; id: string };

export interface ClaudeArgsSpec {
  /** 具体模型 id（例如 claude-opus-5-5），来自路由表。别名（opus）核对不了实际模型，会被判不一致。 */
  model: string;
  session: ClaudeSession;
  /**
   * 权限模式由调用方按阶段定：写码一般 bypassPermissions，审查只读。没有默认值——放开一切权限必须是显式决定，
   * 而且前提是执行体用户读不到机器人私钥之类的凭据。
   */
  permissionMode: ClaudePermissionMode;
  /** 额外放行的工具，例如 `Bash(git diff:*)`。 */
  allowedTools?: readonly string[];
  effort?: ClaudeEffort;
  appendSystemPrompt?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:=,[\]-]*$/;

function assertSessionId(id: string): void {
  if (!UUID.test(id)) throw new Error(`会话号必须是 UUID：${JSON.stringify(id)}`);
}

/** 会话模式对应的命令行片段：new/resume 各带一个会话号，fork 两个都要、顺序固定。 */
function sessionArgs(session: ClaudeSession): string[] {
  assertSessionId(session.id);
  if (session.mode === 'new') return ['--session-id', session.id];
  if (session.mode === 'resume') return ['--resume', session.id];
  assertSessionId(session.from);
  if (session.from === session.id) throw new Error(`fork 的新会话号不能和旧会话号一样：${session.id}`);
  return ['--resume', session.from, '--fork-session', '--session-id', session.id];
}

export function buildClaudeArgs(spec: ClaudeArgsSpec): string[] {
  if (!MODEL.test(spec.model)) throw new Error(`模型名不合法：${JSON.stringify(spec.model)}`);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    // -p 配 stream-json 不带 --verbose 会直接退出 1
    '--verbose',
    '--model',
    spec.model,
    // 只读项目级设置：不跑用户级 hooks，行为和成本都可控
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--permission-mode',
    spec.permissionMode,
    // 无头会话没人答权限弹窗：要批准的一律当场拒，不挂着等
    '--permission-prompts',
    'none',
    ...sessionArgs(spec.session),
  ];
  if (spec.effort) args.push('--effort', spec.effort);
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  // 变长参数放最后、值并成一个参数：它后面再没有东西可吞
  if (spec.allowedTools?.length) args.push('--allowedTools', spec.allowedTools.join(','));
  return args;
}
