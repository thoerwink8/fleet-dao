// fleet-api notify raise（#2729）：法国上的脚本（发版接活 deploy/france/release-request、自动发布 deploy/france/auto-release）
// 写卡住报警走的统一写入口：经 @fleet-dao/db 的 upsertAlert 落库（没有就建、有了原地更新、处理过的重新打开），不再各自直写
// `insert into notifications`。
// 改这里之前必须知道：
// - 只收 alert（卡住报警）和 daily（日报）两级。「要你拍」只给掏新钱、删了找不回、只有人能做的事，带选项和原因，由引擎、后端
//   各自的那一处写（库里 CHECK 兜底）；脚本没有这种事，这里不开口子。
// - 正文从标准输入读（发版的话多行、带引号，不走参数）。
// - 退出码：0 记上了；1 没记上（库出错）；2 参数不对（不连库）。
import { type Db, upsertAlert } from '@fleet-dao/db';

export const NOTIFY_USAGE =
  '用法：fleet-api notify raise --key <去重键> --title "<标题>" [--level alert|daily] [--link </路径>] < 正文' +
  '（脚本写提醒的统一入口，#2729：经 upsertAlert 落库，同键原地更新、处理过的重新打开；只收卡住报警和日报，要你拍不走这里）';

/** 去重键：不带空白和控制字符，最长 200（发版脚本的键里有路径、冒号）。 */
const KEY = /^[^\s\p{Cc}]{1,200}$/u;
const LEVELS = ['alert', 'daily'] as const;
const MAX_TITLE = 200;

export class NotifyCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'NotifyCliError';
    this.exitCode = exitCode;
  }
}

export interface NotifyRaiseArgs {
  key: string;
  title: string;
  level: (typeof LEVELS)[number];
  link: string | null;
}

/** 参数：notify raise，--key、--title 必给；--level 默认 alert；认不出的、缺的、给两次的都是用法错（退出 2）。 */
export function parseNotifyArgs(argv: readonly string[]): NotifyRaiseArgs {
  const [sub, ...rest] = argv;
  if (sub !== 'raise')
    throw new NotifyCliError(sub ? `没有 notify ${sub} 这条命令。\n${NOTIFY_USAGE}` : NOTIFY_USAGE);
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (!['--key', '--title', '--level', '--link'].includes(arg)) {
      throw new NotifyCliError(`认不出参数 ${arg.slice(0, 40)}。\n${NOTIFY_USAGE}`);
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith('--'))
      throw new NotifyCliError(`${arg} 后面要跟值。\n${NOTIFY_USAGE}`);
    if (opts.has(arg)) throw new NotifyCliError(`${arg} 给了两次。\n${NOTIFY_USAGE}`);
    opts.set(arg, value);
  }
  const key = opts.get('--key');
  const title = opts.get('--title')?.trim();
  if (!key || !title) throw new NotifyCliError(`--key 和 --title 都要给。\n${NOTIFY_USAGE}`);
  if (!KEY.test(key)) throw new NotifyCliError(`--key 认不出（不能带空白，最长 200）：${key.slice(0, 40)}`);
  const level = opts.get('--level') ?? 'alert';
  if (!(LEVELS as readonly string[]).includes(level)) {
    throw new NotifyCliError(
      `--level 只收 ${LEVELS.join('、')}（要你拍不走这里：只给掏新钱、删了找不回、只有人能做的事，由引擎、后端写）`,
    );
  }
  const link = opts.get('--link') ?? null;
  if (link !== null && !link.startsWith('/'))
    throw new NotifyCliError(`--link 要是驾驶舱里的路径（/ 开头）：${link}`);
  // 标题太长截断、不拒（报警丢了比标题长更糟）
  const clipped = [...title].length > MAX_TITLE ? `${[...title].slice(0, MAX_TITLE - 1).join('')}…` : title;
  return { key, title: clipped, level: level as NotifyRaiseArgs['level'], link };
}

/** 记一条提醒（统一写入口 upsertAlert）。回提醒编号和是不是新建的。 */
export async function raiseNotify(
  db: Db,
  args: NotifyRaiseArgs,
  body: string,
): Promise<{ id: string; created: boolean }> {
  return upsertAlert(db, {
    dedupeKey: args.key,
    level: args.level,
    taskId: null,
    title: args.title,
    body: body.trimEnd(),
    ...(args.link ? { link: args.link } : {}),
  });
}
