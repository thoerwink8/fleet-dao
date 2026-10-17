// fleet-api emergency-issue（#2728）：法国自动发布单元（deploy/france/auto-release）在同一个提交发版「还没动手就没成」连败满
// UNTOUCHED_FAIL_LIMIT 趟、停下不再自动发时，经它开一张急修单——引擎能接的四节单（贴「缺陷」、进当前版本），不是要人拍的卡。
// 改这里之前必须知道：
// - 正文从标准输入读，四节（场景、原话、已知的模块、怎么算做完）和字数照 `pnpm issue:new` 同一个判法（@fleet-dao/conventions 的
//   checkIssueBody、issueBodyTooLong）；交给引擎的单，「怎么算做完」里要 diff 外证据的条目照那个函数拒开。
// - 开单用「引擎」机器人（@fleet-dao/github 的 openIssue：过卫生检查、中和 @ 提醒、按 key 幂等，同一个 key 只开一张）。
//   key 前面加 emergency:，和驾驶舱提需求的 request: 分开。
// - 不贴「本机做」「要人拍」：拉不拉由引擎的准入决定（决定 0097：急修不问人）。
// - 开在受管仓里叫 fleet-dao 的那个（self-repo.ts）；认不出不猜，退出 1。
// - 退出码：0 开成了（或这个 key 以前开过）；1 没开成（正文不合格、仓认不出、GitHub 没成）；2 参数不对（不连库、不连 GitHub）。
import { checkIssueBody, domainLabel, issueBodyTooLong, natureLabel } from '@fleet-dao/conventions';

export const EMERGENCY_ISSUE_USAGE =
  '用法：fleet-api emergency-issue --key <幂等键> --title "<标题>" [--json] < 正文.md' +
  '（开急修单：四节正文从标准输入读，贴「缺陷」、进当前版本；同一个 key 只开一张。法国自动发布在同一个提交发版连败时调）';

/** 固定的发布故障立案：类别和两轴在创建时一起写入。 */
export const EMERGENCY_LABELS = ['缺陷', domainLabel('engine'), natureLabel('bug')] as const;
/** 幂等键的前缀（和提需求的 request: 分开）。 */
export const EMERGENCY_KEY_PREFIX = 'emergency:';

const KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/;

export class EmergencyIssueError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'EmergencyIssueError';
    this.exitCode = exitCode;
  }
}

export interface EmergencyIssueArgs {
  key: string;
  title: string;
  json: boolean;
}

/** 参数：--key、--title 必给，--json 只把结果打成一行 JSON。认不出的参数、缺的、给两次的都是用法错（退出 2）。 */
export function parseEmergencyIssueArgs(argv: readonly string[]): EmergencyIssueArgs {
  const opts = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg !== '--key' && arg !== '--title') {
      throw new EmergencyIssueError(`认不出参数 ${arg.slice(0, 40)}。\n${EMERGENCY_ISSUE_USAGE}`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--'))
      throw new EmergencyIssueError(`${arg} 后面要跟值。\n${EMERGENCY_ISSUE_USAGE}`);
    if (opts.has(arg)) throw new EmergencyIssueError(`${arg} 给了两次。\n${EMERGENCY_ISSUE_USAGE}`);
    opts.set(arg, value);
  }
  const key = opts.get('--key');
  const title = opts.get('--title')?.trim();
  if (!key || !title) throw new EmergencyIssueError(`--key 和 --title 都要给。\n${EMERGENCY_ISSUE_USAGE}`);
  if (!KEY.test(key)) {
    throw new EmergencyIssueError(`--key 只收字母数字和 : . _ -（最长 120）：${key.slice(0, 40)}`);
  }
  return { key, title, json };
}

/** 开单要的外部能力（「引擎」机器人的 GitHub，挂当前版本）。真实现在 cli.ts 装配；测试换成假的。 */
export interface EmergencyIssuePort {
  openIssue(input: {
    repo: { owner: string; name: string };
    key: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; url: string; created: boolean }>;
}

/** 核正文、开单。正文不合格抛 EmergencyIssueError（退出 1），一次 GitHub 请求都不发。 */
export async function fileEmergencyIssue(
  args: EmergencyIssueArgs,
  body: string,
  deps: { port: EmergencyIssuePort; repo: { owner: string; name: string } },
): Promise<{ number: number; url: string; created: boolean }> {
  const text = body.trim();
  const checked = checkIssueBody(text);
  if (!checked.ok) throw new EmergencyIssueError(`急修单正文不合格：${checked.why}`, 1);
  const tooLong = issueBodyTooLong(text);
  if (tooLong) throw new EmergencyIssueError(tooLong, 1);
  return deps.port.openIssue({
    repo: deps.repo,
    key: `${EMERGENCY_KEY_PREFIX}${args.key}`,
    title: args.title,
    body: text,
    labels: [...EMERGENCY_LABELS],
  });
}
