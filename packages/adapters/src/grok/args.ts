// Grok 命令行（Grok Build 1.0.41）的无头参数，法国 VPS 上实跑。
// - 无头模式不从 stdin 读提示词，但 --prompt-file /dev/stdin 能读真管道（Linux 实测）：提示词照样走 stdin，不落临时文件、
//   不进参数（Node 给子进程的 stdin 是 socketpair，读不了，run.ts 前面垫一个 cat）；
// - 旗标都在前面、不用子命令：放在子命令之后会报 unexpected argument 退出 2（GK-03）；
// - 免确认用 --always-approve：--permission-mode auto 每条外部命令还要确认（GK-04）；
// - 新会话用我们起的 UUID（-s），续跑 -r 同一个号，终帧 end.sessionId 回的就是它；
// - 总带 --no-plan：--always-approve 管不到计划模式（进计划模式要人批，计划里除计划文件外的编辑一律拒，
//   ~/.grok/docs/user-guide/19-plan-mode.md），无人值守会卡着等人点头。目录信任、反问选择题两张卡走环境变量，见 run.ts；
// - 默认带 --disallowed-tools 关掉写码用不上的工具（名单见 GROK_DISALLOWED_TOOLS）：工具定义每次调用都重带一遍（#3588 审计）。
//   1.0.41 的 --help 里有这个旗标；认不得它的老版本会报 unexpected argument 退出 2，所以 run.ts 先看版本，不支持就不带。
import { compareVersions, parseVersion } from '@fleet-dao/shared';
import { assertSessionEffort, GROK_EFFORTS, type SessionEffort } from '../effort.ts';

export type GrokSession = { mode: 'new'; id: string } | { mode: 'resume'; id: string };

/**
 * 会话里关掉的 grok 内置工具（--disallowed-tools，工具内部名，~/.grok/docs/user-guide/14-headless-mode.md）：
 * 图像、视频、反馈、工作流、定时调度，写码用不上。读写文件、执行命令、搜索那几类不许进这份名单。名单只在这里写一处。
 */
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

/** 认得 --disallowed-tools 的最低版本：1.0.41 的 --help 里有（更老的没验过，按不支持算）。 */
export const GROK_DISALLOWED_TOOLS_MIN_VERSION = '1.0.41';

/** 版本读不出来（null）按不支持算：宁可多花 token，也不让会话因为不认旗标起不来。 */
export function grokSupportsDisallowedTools(version: string | null | undefined): boolean {
  const have = version ? parseVersion(version) : null;
  const min = parseVersion(GROK_DISALLOWED_TOOLS_MIN_VERSION);
  return have !== null && min !== null && compareVersions(have, min) >= 0;
}

export interface GrokArgsSpec {
  /** 模型 id，来自路由表（GK-05：别依赖 CLI 默认值，它会换代）。终帧里回的是 grok-4.7-build 这种带后缀的名字。 */
  model: string;
  session: GrokSession;
  /** 工作树。 */
  cwd: string;
  /** --always-approve：工具一律放行。放开权限必须是显式决定，前提是执行体用户读不到凭据。 */
  alwaysApprove: boolean;
  /** 不给就不传，Grok 自己会落到 xhigh。引擎起会话时总是给。max 类型上过得去，运行时拒（Grok 没有这一档）。 */
  reasoningEffort?: SessionEffort;
  maxTurns?: number;
  /** 提示词文件，默认 /dev/stdin（提示词走 stdin）。 */
  promptFile?: string;
  /** 带 --disallowed-tools 关掉 GROK_DISALLOWED_TOOLS；默认带。命令行版本不认这个旗标时 run.ts 传 false。 */
  disallowTools?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function buildGrokArgs(spec: GrokArgsSpec): string[] {
  if (!MODEL.test(spec.model)) throw new Error(`模型名不合法：${JSON.stringify(spec.model)}`);
  if (!UUID.test(spec.session.id)) throw new Error(`会话号必须是 UUID：${JSON.stringify(spec.session.id)}`);
  if (spec.reasoningEffort !== undefined) {
    assertSessionEffort(spec.reasoningEffort, GROK_EFFORTS, 'Grok 命令行');
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
    '--no-plan',
    ...(spec.disallowTools === false ? [] : ['--disallowed-tools', GROK_DISALLOWED_TOOLS.join(',')]),
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
