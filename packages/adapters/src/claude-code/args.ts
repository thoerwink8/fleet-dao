// reclaude（原样转给 claude）的无头参数。提示词不进参数，走 stdin：超长会 E2BIG，而且 --allowedTools 吃变长参数，
// 放在它后面的提示词会被当成工具名（已实测）。
import { fileURLToPath } from 'node:url';
import { assertSessionEffort, SESSION_EFFORTS, type SessionEffort } from '../effort.ts';

export const CLAUDE_PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** 和 `claude --effort` 的 help 一致：low、medium、high、xhigh、max。 */
export type ClaudeEffort = SessionEffort;

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
  /**
   * false = 不把这次会话的记录存进执行体用户家里（`--no-session-persistence`，只对 -p 有效；之后续不上）。
   * 路由探针用：每 15 分钟一次的一问一答不留记录。干活的会话要能续，不给（默认存）。
   */
  persistSession?: boolean;
  /** 调工具前那条钩子的脚本，默认 PRETOOL_SCRIPT；只有测试、验收脚本改它。 */
  pretoolScript?: string;
}

/**
 * 调工具前那条钩子（只拦本机 reclaude login / logout / org use，和直接 gh issue create；规矩在脚本里）：仓里这一份，
 * 和引擎同一版。法国上它在 /srv/fleet-dao-releases/<提交号>/ 下，归 root、谁都能读：会话改不了、删不掉它；会话用户家里
 * agents-sync 装的那份归会话用户（会话自己就能改掉），引擎也读不到那个家目录，所以不用那份。
 */
export const PRETOOL_SCRIPT = fileURLToPath(new URL('../../../../agents/hooks/pretool.mjs', import.meta.url));

/** 和 packages/agents-sync/src/targets.ts 里 Claude 那组一样：只挂跑命令的 Bash、PowerShell。 */
export const PRETOOL_MATCHER = 'Bash|PowerShell';

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * 经 --settings 带上的那份设置：引擎起 Claude 带 --setting-sources project，用户级 settings.json 里登记的钩子它不读，
 * 命令行给的设置是单独一层（不受 --setting-sources 管：法国 2026-09-27 以 2.1.282 实测，test/e2e/claude-guard-e2e.ts）。
 * 钩子退出码 2 = 拦下；别的非 0（脚本崩了、node 起不来）Claude 当「钩子出错」照样放行，没人看着的会话里等于没装：
 * 这里一律改成 2、说清没跑成（按拦处理）。脚本不在由 runClaudeCode 起会话之前查，查不到不起。
 */
export function pretoolSettings(script: string = PRETOOL_SCRIPT, node: string = process.execPath): string {
  const command = `${shellQuote(node)} ${shellQuote(script)} || { c=$?; [ "$c" = 2 ] || echo "fleet-guard：调工具前的钩子没跑成（退出码 $c），按拦处理" >&2; exit 2; }`;
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: PRETOOL_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] }] },
  });
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
    // 只读项目级设置：不跑用户级 hooks，行为和成本都可控；调工具前那条钩子另经 --settings 带上
    '--setting-sources',
    'project',
    '--settings',
    pretoolSettings(spec.pretoolScript),
    '--strict-mcp-config',
    '--permission-mode',
    spec.permissionMode,
    // 无头会话没人答权限弹窗：要批准的一律当场拒，不挂着等
    '--permission-prompts',
    'none',
    ...sessionArgs(spec.session),
  ];
  if (spec.persistSession === false) {
    // 不存的会话续不上：续会话、fork 要的正是上一轮存下的记录，两样一起给是写错了
    if (spec.session.mode !== 'new')
      throw new Error(`不存记录的会话只能是新会话，给的是 ${spec.session.mode}`);
    args.push('--no-session-persistence');
  }
  if (spec.effort !== undefined) {
    // 类型擦掉之后，不认识的字符串也会进到这里：不传给命令行
    assertSessionEffort(spec.effort, SESSION_EFFORTS, 'Claude Code');
    args.push('--effort', spec.effort);
  }
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  // 变长参数放最后、值并成一个参数：它后面再没有东西可吞
  if (spec.allowedTools?.length) args.push('--allowedTools', spec.allowedTools.join(','));
  return args;
}
