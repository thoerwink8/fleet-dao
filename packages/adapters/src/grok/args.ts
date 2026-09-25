// Grok 命令行（Grok Build 1.0.41）的无头参数，法国 VPS 上实跑。
// - 无头模式不从 stdin 读提示词，但 --prompt-file /dev/stdin 能读真管道（Linux 实测）：提示词照样走 stdin，不落临时文件、
//   不进参数（Node 给子进程的 stdin 是 socketpair，读不了，run.ts 前面垫一个 cat）；
// - 旗标都在前面、不用子命令：放在子命令之后会报 unexpected argument 退出 2（GK-03）；
// - 免确认用 --always-approve：--permission-mode auto 每条外部命令还要确认（GK-04）；
// - 新会话用我们起的 UUID（-s），续跑 -r 同一个号，终帧 end.sessionId 回的就是它。
export type GrokSession = { mode: 'new'; id: string } | { mode: 'resume'; id: string };

export interface GrokArgsSpec {
  /** 模型 id，来自路由表（GK-05：别依赖 CLI 默认值，它会换代）。终帧里回的是 grok-4.7-build 这种带后缀的名字。 */
  model: string;
  session: GrokSession;
  /** 工作树。 */
  cwd: string;
  /** --always-approve：工具一律放行。放开权限必须是显式决定，前提是执行体用户读不到凭据。 */
  alwaysApprove: boolean;
  reasoningEffort?: string;
  maxTurns?: number;
  /** 提示词文件，默认 /dev/stdin（提示词走 stdin）。 */
  promptFile?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function buildGrokArgs(spec: GrokArgsSpec): string[] {
  if (!MODEL.test(spec.model)) throw new Error(`模型名不合法：${JSON.stringify(spec.model)}`);
  if (!UUID.test(spec.session.id)) throw new Error(`会话号必须是 UUID：${JSON.stringify(spec.session.id)}`);
  if (spec.reasoningEffort !== undefined && !/^[a-z]+$/.test(spec.reasoningEffort)) {
    throw new Error(`reasoning effort 不合法：${JSON.stringify(spec.reasoningEffort)}`);
  }
  if (spec.maxTurns !== undefined && !(Number.isInteger(spec.maxTurns) && spec.maxTurns > 0)) {
    throw new Error(`max turns 不合法：${spec.maxTurns}`);
  }
  if (!spec.cwd) throw new Error('没给工作树');
  return [
    '--prompt-file',
    spec.promptFile ?? '/dev/stdin',
    '--output-format',
    'streaming-json',
    ...(spec.alwaysApprove ? ['--always-approve'] : []),
    '-m',
    spec.model,
    '--cwd',
    spec.cwd,
    spec.session.mode === 'new' ? '-s' : '-r',
    spec.session.id,
    ...(spec.reasoningEffort ? ['--reasoning-effort', spec.reasoningEffort] : []),
    ...(spec.maxTurns ? ['--max-turns', String(spec.maxTurns)] : []),
  ];
}

/** 点名 grok-4.7，终帧回 grok-4.7-build：同一个模型带了渠道后缀。换代（4.6 ↔ 4.7）才算不一致。 */
export function grokModelMatches(requested: string, observed: string): boolean {
  const a = requested.trim().toLowerCase();
  const b = observed.trim().toLowerCase();
  return a === b || b.startsWith(`${a}-`);
}
