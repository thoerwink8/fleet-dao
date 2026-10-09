// 后端的管理命令（法国上以 root 经 packages/api/bin/fleet-api 跑，见 docs/ops.md 第九节「账密登录」「让 AI 接活」）。
//   set-password <飞书名或用户 id> [--username <用户名>]
// 给白名单里的人设（或重设）账密登录的密码：飞书登录出问题时也进得去驾驶舱。
// 密码只从标准输入读，读两遍要一致：终端里不回显；从管道来就读两行。不接受命令行参数传密码（会进 shell 历史和进程列表）。
// 只能给白名单里的人设（users 表里在用的创始人）；设了之后输错计数和锁清零，操作记录里写一条。
//   dispatch <owner/仓名> on|off|status
//   dispatch --all off --reason <原因>
// 「让 AI 接活」开关（repos.auto_dispatch_since）：驾驶舱的开关页面（#131）之前的唯一入口，之后留作运维的后备。
// 写入口和页面同一个（Store.setAutoDispatch）；改了记一条操作记录，改完从库里读回开关和那条记录再打印。
// --all off：把库里所有仓都关上（发版 release.sh 在里程碑新 tag 发布成功后调，#1050）；只许 off，不许一键全开；
// 逐个仓走上面同一条路，已经关着的不改不记；有一个没关成就整条退出 1，说清哪几个。
//   engine on|off|status [--reason <原因>]
// 引擎总开关（设置 engine.master，#1086）：on 打开引擎接活，off 全停（不拉单、不派活、不起干活的会话；探针照跑），
// status 只看。没设过是关。和按项目的「让 AI 接活」串联：总开关开着、项目的开关也开着才派。发版脚本每次发版成功后
// 经 engine off 置关（#1050）；本机 WSL 的小版本更新不碰它。
//   node-key new <环境编号>（看板多机）：给一个要往这台推快照的环境发一把新通行证：明文只在这一次打印（推送方放进自己的
//   FLEET_NODE_REPORT_TOKEN），同时打印要贴进这台 api.env 的 FLEET_NODE_KEYS 的那一项（只有哈希）。先写操作记录（不含明文、哈希），
//   记不成就不打印——发出去的钥匙必须有记录。不改任何配置文件、不重启服务。
//   alert …（design 15.3「谁在处理」）：开着的提醒谁在处理、修到哪；静默。写法和退出码见 alert-cli.ts。
//   intent …（#553 第 4 条）：指挥官经 ssh 读飞书意图的全部原话、开单时写回归纳和「已开成 #N」、放下。见 intent-cli.ts。
//   task continue|abandon|redo <owner/仓名> <单号> --note "<为什么>"（#1402）：续、放弃、重做一张单。见 task-cli.ts。
// 每条命令带 --help（或 -h）只打印用法。
// 退出码（几条命令一样）：0 做成了（或本来就是）；1 没做成（被拒、库里没有、连不上库、读回来不对，一句话说原因）；2 参数不对或没带上库连接。

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { ENGINE_LABEL, LOCAL_LABEL } from '@fleet-dao/conventions';
import { AUTO_DISPATCH_DISABLE, AUTO_DISPATCH_ENABLE, NodeIdSchema } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { AlertWorkPort } from '@fleet-dao/store';
import { ALERT_USAGE, AlertCliError, runAlert } from './alert-cli.ts';
import { describeEngineMaster, readEngineMaster, setEngineMaster } from './engine-switch.ts';
import { INTENT_USAGE, IntentCliError, parseIntentArgs, runIntent } from './intent-cli.ts';
import type { IntentStore } from './intent-store.ts';
import { checkNewPassword, checkUsername, hashPassword } from './password.ts';
import type { AuditRecord, AutoDispatchChange, IntakeRepo, Store, User } from './ports.ts';
import { isCockpitUser } from './session.ts';
import {
  type OpenedTaskControl,
  openTaskControl,
  parseTaskArgs,
  runTask,
  TASK_USAGE,
  TaskCliError,
} from './task-cli.ts';

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

const USAGE =
  '用法：fleet-api set-password <飞书名或用户 id> [--username <用户名>]（密码从标准输入读，不收参数）';
const ENGINE_USAGE =
  '用法：fleet-api engine on|off|status [--reason <原因>]（引擎总开关：on 打开，off 关上，status 只看；没设过是关。开关写进操作记录，本来就是要的状态就不改不记）';
/** dispatch-issue（#1337）的本体在引擎包（packages/engine/src/bin/dispatch-issue.ts）：后端不依赖引擎包，由 bin/fleet-api 按命令名转过去。这里只管 --help 列得出来。 */
const DISPATCH_ISSUE_POINTER =
  '用法：fleet-api dispatch-issue <owner/仓名> <单号> [--force --note "<为什么>"]（开关关着时点名把一张单交给引擎；本体在引擎包，经 packages/api/bin/fleet-api 转过去，完整说明跑 fleet-api dispatch-issue --help）';
/** groom（#1338，叫一次临时指挥官整理待办）同样：本体在引擎包（packages/engine/src/bin/groom.ts），由 bin/fleet-api 转过去。 */
const GROOM_POINTER =
  '用法：fleet-api groom <owner/仓名> [--note "<为什么>"]（叫一次临时指挥官整理待办，只排队、引擎几秒内接手；本体在引擎包，经 packages/api/bin/fleet-api 转过去，完整说明跑 fleet-api groom --help）';
const NODE_KEY_USAGE =
  '用法：fleet-api node-key new <环境编号>（环境编号：小写字母开头，只许小写字母、数字、短横线；打印一次通行证明文和要贴进 FLEET_NODE_KEYS 的哈希）';
const DISPATCH_USAGE =
  '用法：fleet-api dispatch <owner/仓名> on|off|status（「让 AI 接活」开关：on 打开，off 关上，status 只看）；fleet-api dispatch --all off --reason <原因>（所有仓都关上，原因写进操作记录）';

export interface SetPasswordArgs {
  who: string;
  username?: string | undefined;
}

/** 认不出的参数一律拒（包括想拿参数传密码的 --password 之类），不猜。 */
export function parseSetPasswordArgs(argv: readonly string[]): SetPasswordArgs {
  let who: string | undefined;
  let username: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--username') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new CliError(`--username 后面要跟用户名。${USAGE}`, 2);
      username = value;
    } else if (arg.startsWith('-')) {
      throw new CliError(`认不出参数 ${arg.split('=')[0]}（密码不从参数传）。${USAGE}`, 2);
    } else if (who === undefined) {
      who = arg;
    } else {
      throw new CliError(`多了参数。${USAGE}`, 2);
    }
  }
  if (!who) throw new CliError(USAGE, 2);
  return { who, username };
}

export interface Prompter {
  /** 读一行，回显（用户名用）。 */
  ask(question: string): Promise<string>;
  /** 读一行，不回显（密码用）。 */
  askHidden(question: string): Promise<string>;
}

async function findTarget(store: Store, who: string): Promise<User> {
  const byId = await store.getUser(who);
  if (byId) return byId;
  const matches = (await store.listUsers()).filter((u) => u.displayName === who);
  if (matches.length > 1) {
    throw new CliError(`叫「${who}」的有 ${matches.length} 个，请改用用户 id`);
  }
  const user = matches[0];
  if (!user) throw new CliError(`库里没有叫「${who}」或编号是它的人`);
  return user;
}

/** 设密码。成功返回给人看的一句话（不含密码）；任何一步不对抛 CliError，什么都不改。 */
export async function setPassword(input: {
  store: Store;
  args: SetPasswordArgs;
  prompt: Prompter;
  now: () => Date;
}): Promise<string> {
  const { store, args, prompt } = input;
  const user = await findTarget(store, args.who);
  if (!isCockpitUser(user)) {
    throw new CliError(`「${user.displayName}」不在驾驶舱白名单里（只放行在用的创始人），不给设密码`);
  }
  const creds = await store.getPasswordCredentials(user.id);
  if (!creds) throw new CliError(`读不到「${user.displayName}」的登录信息`);

  let username = args.username ?? creds.username;
  if (username === undefined) username = (await prompt.ask('这个人还没有用户名，设一个：')).trim();
  const badName = checkUsername(username);
  if (badName) throw new CliError(badName.message);

  const password = await prompt.askHidden('新密码（不显示）：');
  const badPassword = checkNewPassword(password);
  if (badPassword) throw new CliError(badPassword.message);
  const again = await prompt.askHidden('再输一遍：');
  if (again !== password) throw new CliError('两遍不一样，什么都没改');

  const passwordHash = await hashPassword(password);
  const result = await store.setPasswordCredentials(
    { userId: user.id, username, passwordHash, at: input.now() },
    {
      // 操作记录没有「服务器上的管理命令」这一种来源：记成引擎那一类，reason 写明是哪条命令
      actor: { kind: 'engine', id: 'ops:set-password' },
      action: 'credentials.set',
      target: `user:${user.id}`,
      before: { username: creds.username ?? null, hasPassword: creds.passwordHash !== undefined },
      after: { username, passwordChanged: true },
      reason: '服务器上 root 跑的 fleet-api set-password',
      via: 'engine',
      ok: true,
    },
  );
  if (result === 'username_taken')
    throw new CliError(`用户名「${username}」已经有人用了，换一个（--username）`);
  if (result === 'not_found') throw new CliError(`「${user.displayName}」刚刚不在库里了，什么都没改`);
  return `已给「${user.displayName}」设好密码，用户名 ${username}；输错计数和锁已清零`;
}

/**
 * 标准输入是终端：关回显逐字读（退格能删，Ctrl-C 放弃）。是管道：按行读（给脚本用，一样读两遍）。
 * 不是终端时回显无从谈起，也不会把密码写到任何输出上。
 */
export function stdioPrompter(): Prompter & { close(): void } {
  const stdin = process.stdin;
  const err = process.stderr;
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  let rl: ReturnType<typeof createInterface> | undefined;

  function pipeLine(): Promise<string> {
    if (!rl) {
      rl = createInterface({ input: stdin, terminal: false });
      rl.on('line', (line) => {
        const w = waiting.shift();
        if (w) w(line);
        else lines.push(line);
      });
      rl.on('close', () => {
        ended = true;
        for (const w of waiting.splice(0)) w(undefined);
      });
    }
    const ready = lines.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    if (ended) return Promise.reject(new CliError('标准输入读完了，没读到要的那一行'));
    return new Promise((resolve, reject) =>
      waiting.push((line) =>
        line === undefined ? reject(new CliError('标准输入读完了，没读到要的那一行')) : resolve(line),
      ),
    );
  }

  function ttyLine(question: string, hidden: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      err.write(question);
      let buf = '';
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const done = (fn: () => void) => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        err.write('\n');
        fn();
      };
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') return done(() => resolve(buf));
          if (ch === '\u0003' || ch === '\u0004')
            return done(() => reject(new CliError('放弃了，什么都没改', 130)));
          if (ch === '\u007f' || ch === '\b') {
            if (buf.length > 0) {
              buf = [...buf].slice(0, -1).join('');
              if (!hidden) err.write('\b \b');
            }
            continue;
          }
          buf += ch;
          if (!hidden) err.write(ch);
        }
      };
      stdin.on('data', onData);
    });
  }

  function read(question: string, hidden: boolean): Promise<string> {
    if (stdin.isTTY) return ttyLine(question, hidden);
    err.write(question);
    return pipeLine();
  }

  return {
    ask: (q) => read(q, false),
    askHidden: (q) => read(q, true),
    close: () => rl?.close(),
  };
}

// —— node-key：给往这台推快照的环境发通行证 ——

/** node-key 的操作记录：和 set-password 一样记成引擎那一类，reason 写明谁跑的哪条命令。 */
export const NODE_KEY_NEW = 'node_key.new';

/** 只认 `new <环境编号>` 这一种写法；别的子命令、多的参数、带 - 的一律拒，不猜。 */
export function parseNodeKeyArgs(argv: readonly string[]): { id: string } {
  const [sub, id, ...extra] = argv;
  if (sub !== 'new') throw new CliError(NODE_KEY_USAGE, 2);
  const flag = [id, ...extra].find((a) => a?.startsWith('-'));
  if (flag !== undefined) throw new CliError(`认不出参数 ${flag.split('=')[0]}。${NODE_KEY_USAGE}`, 2);
  if (id === undefined || extra.length > 0) throw new CliError(`要恰好一个环境编号。${NODE_KEY_USAGE}`, 2);
  if (!NodeIdSchema.safeParse(id).success) {
    throw new CliError(`环境编号「${id}」不合法。${NODE_KEY_USAGE}`, 2);
  }
  return { id };
}

/**
 * 发一把新通行证：随机 32 字节（43 个字符），哈希是明文的 sha256 十六进制（接收方 node-report.ts 同一个算法）。
 * 先写操作记录再回明文：记录写不进抛错、什么都不打印。回的文字就是要给人看的全部（明文只有这一份）。
 */
export async function newNodeKey(input: {
  store: Store;
  id: string;
  operator: string;
  token?: (() => string) | undefined;
}): Promise<string> {
  const token = (input.token ?? (() => randomBytes(32).toString('base64url')))();
  const hash = createHash('sha256').update(token).digest('hex');
  try {
    await input.store.appendAudit({
      actor: { kind: 'engine', id: 'ops:node-key' },
      action: NODE_KEY_NEW,
      target: `node:${input.id}`,
      // 只记哈希的前 12 位当指纹：对不上是哪一把时用，拿它还原不出通行证
      after: { fingerprint: hash.slice(0, 12) },
      reason: `服务器上 ${input.operator} 跑的 fleet-api node-key new ${input.id}`,
      via: 'engine',
      ok: true,
    });
  } catch (err) {
    throw new CliError(`没发成：操作记录写不进（${errMessage(err)}），没有打印通行证`);
  }
  return [
    `环境 ${input.id} 的通行证（只显示这一次，这边不存明文）：`,
    `  ${token}`,
    '',
    `1. 这一台（收的一方）：api.env 的 FLEET_NODE_KEYS 里加这一项（已有别的环境就用逗号接在同一个 JSON 对象里），再重启 fleet-api：`,
    `  "${input.id}":"${hash}"`,
    `2. 推送方那一台：api.env 里 FLEET_NODE_REPORT_TOKEN 填上面那串通行证，FLEET_NODE_REPORT_URL 填这一台的 /api/nodes/report 地址，再重启 fleet-api。`,
    `明文别进聊天、仓库、日志；这一份丢了就重新发一把（旧的从 FLEET_NODE_KEYS 里删掉就作废）。`,
  ].join('\n');
}

// —— dispatch：「让 AI 接活」开关 ——

export type DispatchAction = 'on' | 'off' | 'status';

export interface DispatchArgs {
  owner: string;
  name: string;
  action: DispatchAction;
  /** 写进操作记录的原因；不给就记「服务器上 <谁> 跑的 fleet-api dispatch <仓> <动作>」。--all 带它来。 */
  reason?: string | undefined;
}

export interface DispatchAllArgs {
  reason: string;
}

const MAX_REASON = 200;

/** dispatch --all off --reason <原因>：只认这一种写法（三样都要有、不多不少），认不出的一律拒，不猜。 */
export function parseDispatchAllArgs(argv: readonly string[]): DispatchAllArgs {
  const rest = argv.slice(1); // argv[0] 是 --all
  const at = rest.indexOf('--reason');
  const reason = at < 0 ? undefined : rest[at + 1];
  const others = rest.filter((_, i) => i !== at && i !== at + 1);
  if (others.length !== 1 || others[0] !== 'off')
    throw new CliError(`--all 只能配 off（没有一键全开）。${DISPATCH_USAGE}`, 2);
  if (reason === undefined || reason.trim() === '' || reason.startsWith('--'))
    throw new CliError(`--all off 要带 --reason <原因>（写进每个仓的操作记录）。${DISPATCH_USAGE}`, 2);
  if (reason.length > MAX_REASON)
    throw new CliError(`--reason 太长（最多 ${MAX_REASON} 个字）。${DISPATCH_USAGE}`, 2);
  return { reason: reason.trim() };
}

/** 操作记录里开、关这两件事的名字（定义在 shared：驾驶舱的开关按钮记同一对）；target 是 repo:<仓的编号>。 */
export { AUTO_DISPATCH_DISABLE, AUTO_DISPATCH_ENABLE };

/** 操作记录没有「服务器上的管理命令」这一种来源：和 set-password 一样记成引擎那一类，reason 写明谁跑的哪条命令。 */
const OPS_DISPATCH = { kind: 'engine', id: 'ops:dispatch' } as const;

/** GitHub 的写法：owner 是字母、数字、连字符，仓名再加 . 和 _。网址、只写仓名、多一段都认不出。 */
const REPO_ARG = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;

/** 恰好两个参数：仓，和 on、off、status 之一。这条命令没有选项，带 - 的一律拒，不猜。 */
export function parseDispatchArgs(argv: readonly string[]): DispatchArgs {
  const flag = argv.find((a) => a.startsWith('-'));
  if (flag !== undefined) throw new CliError(`认不出参数 ${flag.split('=')[0]}。${DISPATCH_USAGE}`, 2);
  if (argv.length !== 2) throw new CliError(`要两个参数：仓，和 on、off、status 之一。${DISPATCH_USAGE}`, 2);
  const [repo = '', action = ''] = argv;
  const m = REPO_ARG.exec(repo);
  if (!m?.[1] || !m[2]) throw new CliError(`认不出仓「${repo}」：要写成 owner/仓名。${DISPATCH_USAGE}`, 2);
  if (action !== 'on' && action !== 'off' && action !== 'status')
    throw new CliError(`认不出「${action}」：只收 on、off、status。${DISPATCH_USAGE}`, 2);
  return { owner: m[1], name: m[2], action };
}

/** 连不上库的那几种：Node 的网络错误码、postgres.js 自己的、Postgres 不让连的 SQLSTATE。 */
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOENT',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P03',
  '3D000',
  '28000',
  '28P01',
  '53300',
]);

/**
 * 库那一步出的错，一句白话，带错误码和原文。drizzle 把驱动的错包成「Failed query: …」（带整句 SQL 和参数），
 * 真原因在 cause 里，取最里面那一层。连不上的说「连不上库」，连上了出错的说「库出错」。
 */
export function describeDbError(err: unknown): string {
  let inner = err;
  for (let i = 0; i < 10 && inner instanceof Error && inner.cause !== undefined; i++) inner = inner.cause;
  const raw = (inner as { code?: unknown } | null | undefined)?.code;
  const code = typeof raw === 'string' && raw !== '' ? raw : undefined;
  let text = errMessage(inner);
  // IPv4、IPv6 都试过、都连不上时 Node 给的是 AggregateError：message 是空的，原因在 errors 里
  if (!text && inner instanceof AggregateError)
    text = inner.errors
      .map((e: unknown) => errMessage(e))
      .filter(Boolean)
      .join('；');
  const detail = code && !text.includes(code) ? `${code}：${text}` : text || code || '没说原因';
  return code !== undefined && CONNECT_CODES.has(code) ? `连不上库（${detail}）` : `库出错（${detail}）`;
}

/** 库那一步：出错就停下，说清做到哪了（lead）、原因、接下来怎么办（tail）。 */
async function dbStep<T>(lead: string, fn: () => Promise<T>, tail = ''): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new CliError(`${lead}${describeDbError(err)}${tail}`, 1);
  }
}

const switchText = (since: string | null) => (since === null ? '关着' : `开着，自 ${since} 起`);

/** 同一时刻不同写法算同一个；关着只等于关着。 */
const sameSwitch = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);

const isSwitchEntry = (a: AuditRecord) =>
  a.action === AUTO_DISPATCH_ENABLE || a.action === AUTO_DISPATCH_DISABLE;

function describeSwitch(label: string, since: string | null): string {
  return since === null
    ? `${label}：让 AI 接活 关着（auto_dispatch_since 为空：只收单、显示，不派）`
    : `${label}：让 AI 接活 开着，自 ${since} 起（引擎自己按依据挑单：开着的独立 issue 不论哪天开的、挂不挂版本，准入过了就按版本先后、当前版本、规模、失败次数、开单早晚排队，每小时最多起 20 条，失败过半会停拉；作者不在白名单、母单和子单、贴了「${LOCAL_LABEL}」的仍不派；贴「${ENGINE_LABEL}」只是同规模里排前一点；「${LOCAL_LABEL}」和「${ENGINE_LABEL}」一起贴时以「${LOCAL_LABEL}」为准）`;
}

/** 读回、status 看最近多少条和这个仓有关的操作记录。 */
const RECENT_AUDITS = 50;

function describeChange(entry: AuditRecord | undefined, more = false): string {
  if (!entry)
    return more
      ? `最近 ${RECENT_AUDITS} 条和它有关的操作记录里没有开关它的（更早的没翻）`
      : '操作记录里还没有开关它的记录';
  const what = entry.action === AUTO_DISPATCH_ENABLE ? '打开' : '关上';
  return `最近一次开关：${entry.at} ${what}，${entry.reason ?? `${entry.actor.kind}:${entry.actor.id}`}（操作记录 ${entry.id}）`;
}

/**
 * fleet-api dispatch 本身。先读开关（findRepoByName：接活读的就是它），status 到这里就打印；on、off 已经是要的状态就不改，
 * 不然经 setAutoDispatch 改（和操作记录同一事务），再从库里读回开关和那条操作记录，对得上才算改好。任何一步不对抛 CliError。
 */
export async function dispatch(input: {
  store: Store;
  args: DispatchArgs;
  operator: string;
}): Promise<string> {
  const { store, args, operator } = input;
  const asked = `${args.owner}/${args.name}`;
  const untouched = args.action === 'status' ? '没查成：' : '没改成（什么都没改）：';
  const found = await dbStep(untouched, () => store.findRepoByName(args.owner, args.name));
  if (!found)
    throw new CliError(`${untouched}库里没有仓 ${asked}（受管的仓就是 repos 表的行，见 docs/ops.md 第九节）`);
  const repo: IntakeRepo = found;
  const label = `${repo.owner}/${repo.name}`;
  const target = `repo:${repo.id}`;
  const recent = (lead: string, tail = '') =>
    dbStep(lead, () => store.listAudit({ target, limit: RECENT_AUDITS }), tail);

  if (args.action === 'status') {
    const page = await recent('没查成：读操作记录时');
    const last = page.items.find(isSwitchEntry);
    return `${describeSwitch(label, repo.autoDispatchSince)}\n${describeChange(last, page.nextCursor !== undefined)}`;
  }

  const on = args.action === 'on';
  if ((repo.autoDispatchSince !== null) === on)
    return `没改：${label} 本来就${switchText(repo.autoDispatchSince)}${on ? '（再开不重设时刻）' : ''}`;

  const change: AutoDispatchChange | 'not_found' = await dbStep(
    '没改成：写库时',
    () =>
      store.setAutoDispatch(
        { repoId: repo.id, on },
        {
          actor: OPS_DISPATCH,
          action: on ? AUTO_DISPATCH_ENABLE : AUTO_DISPATCH_DISABLE,
          target,
          reason:
            args.reason === undefined
              ? `服务器上 ${operator} 跑的 fleet-api dispatch ${label} ${args.action}`
              : `${args.reason}（服务器上 ${operator} 跑的 fleet-api dispatch ${label} ${args.action}）`,
          via: 'engine',
          ok: true,
        },
      ),
    '。开关和操作记录在同一个事务里，要么都改了、要么都没改：跑 status 看现在是哪样',
  );
  if (change === 'not_found') throw new CliError(`没改成：仓 ${label} 刚刚不在库里了，什么都没改`);
  if (!change.changed) return `没改：${label} 刚被别处改成了${switchText(change.autoDispatchSince)}`;

  // 读回：开关和刚记的那条操作记录都要在库里对得上，才算改好
  const wrote = `已经改成「${switchText(change.autoDispatchSince)}」（操作记录 ${change.auditId ?? '没给编号'}），但`;
  const back = await dbStep(
    `${wrote}读回开关时`,
    () => store.findRepoByName(repo.owner, repo.name),
    '：跑 status 核对',
  );
  if (!back || !sameSwitch(back.autoDispatchSince, change.autoDispatchSince))
    throw new CliError(
      `${wrote}读回来是「${back ? switchText(back.autoDispatchSince) : '库里没有这个仓了'}」，对不上：多半刚被别处改过，跑 status 核对`,
    );
  const entry = (await recent(`${wrote}读回操作记录时`, '：跑 status 核对')).items.find(
    (a) => a.id === change.auditId,
  );
  if (!entry) throw new CliError(`${wrote}读回时库里找不到这条操作记录：跑 status 核对`);
  return `已${on ? '打开' : '关上'}：${describeSwitch(label, back.autoDispatchSince)}\n${describeChange(entry)}`;
}

/**
 * fleet-api dispatch --all off：库里每个仓各走一遍上面的 dispatch（同一个写入口、同一个读回），一个仓失败不拦着别的仓，
 * 最后有失败的就整条抛出、说清哪几个没关成。没有一个仓也算做完（打印说明），但要说出来，不假装关了什么。
 */
export async function dispatchAll(input: {
  store: Store;
  args: DispatchAllArgs;
  operator: string;
}): Promise<string> {
  const { store, args, operator } = input;
  const all = await dbStep('没改成：读仓列表时', () => store.listRepos());
  if (all.length === 0) return '库里一个仓都没有，没有要关的';
  const lines: string[] = [];
  const failed: string[] = [];
  for (const r of all) {
    try {
      const one: DispatchArgs = { owner: r.owner, name: r.name, action: 'off', reason: args.reason };
      lines.push(await dispatch({ store, args: one, operator }));
    } catch (err) {
      failed.push(`${r.owner}/${r.name}：${err instanceof CliError ? err.message : errMessage(err)}`);
    }
  }
  if (failed.length > 0) {
    const done = lines.length > 0 ? `\n已处理的：\n${lines.join('\n')}` : '';
    throw new CliError(
      `${all.length} 个仓里 ${failed.length} 个没关成（别的仓已照常处理）：\n${failed.join('\n')}${done}`,
    );
  }
  return `${all.length} 个仓都已关着：\n${lines.join('\n')}`;
}

// —— engine：引擎总开关（#1086，设置 engine.master）——

export interface EngineArgs {
  action: 'on' | 'off' | 'status';
  reason?: string | undefined;
}

/** 恰好一个动作，可选 --reason <原因>；别的写法一律拒，不猜。 */
export function parseEngineArgs(argv: readonly string[]): EngineArgs {
  const [action = '', ...rest] = argv;
  if (action !== 'on' && action !== 'off' && action !== 'status')
    throw new CliError(`认不出「${action}」：只收 on、off、status。${ENGINE_USAGE}`, 2);
  let reason: string | undefined;
  if (rest.length > 0) {
    if (rest.length !== 2 || rest[0] !== '--reason' || rest[1] === undefined || rest[1].trim() === '')
      throw new CliError(`--reason 要写成 --reason <原因>。${ENGINE_USAGE}`, 2);
    if (action === 'status') throw new CliError(`status 不看原因。${ENGINE_USAGE}`, 2);
    reason = rest[1].trim();
    if (reason.length > MAX_REASON)
      throw new CliError(`--reason 太长（最多 ${MAX_REASON} 个字）。${ENGINE_USAGE}`, 2);
  }
  return { action, ...(reason === undefined ? {} : { reason }) };
}

/** 操作记录没有「服务器上的管理命令」这一种来源：和 dispatch 一样记成引擎那一类，reason 写明谁跑的哪条命令。 */
const OPS_ENGINE = { kind: 'engine', id: 'ops:engine' } as const;

/**
 * fleet-api engine 本身（#1086）。status 只读打印；on、off 已经是要的状态就不改，不然经 setEngineMaster 改
 * （putSetting：开关和操作记录同一事务）；版本冲突（刚被别处改过）报出来让重跑。
 */
export async function engine(input: { store: Store; args: EngineArgs; operator: string }): Promise<string> {
  const { store, args, operator } = input;
  if (args.action === 'status') {
    const state = await dbStep('没查成：', () => readEngineMaster(store));
    return `引擎总开关：${describeEngineMaster(state)}`;
  }
  const on = args.action === 'on';
  const change = await dbStep(
    '没改成（什么都没改）：',
    () =>
      setEngineMaster(
        store,
        { on, by: OPS_ENGINE },
        {
          actor: OPS_ENGINE,
          reason:
            args.reason === undefined
              ? `服务器上 ${operator} 跑的 fleet-api engine ${args.action}`
              : `${args.reason}（服务器上 ${operator} 跑的 fleet-api engine ${args.action}）`,
          via: 'engine',
          ok: true,
        },
      ),
    '。开关和操作记录在同一个事务里，要么都改了、要么都没改：跑 status 看现在是哪样',
  );
  if ('conflict' in change)
    throw new CliError(
      `没改成：总开关刚被别处改过（现在是「${describeEngineMaster(change.state)}」），再跑一遍或跑 status 核对`,
    );
  if (!change.changed)
    return `没改：总开关本来就${on ? '开着' : '关着'}（现在是「${describeEngineMaster(change.state)}」）`;
  return `已${on ? '打开' : '关上'}：引擎总开关：${describeEngineMaster(change.state)}`;
}

/**
 * 谁跑的。bin/fleet-api 换成 fleet 身份之前，把 root（经 sudo 跑的记 sudo 前的用户）放进 FLEET_OPS_OPERATOR；
 * 没经它、直接跑 node 的，记这个进程的用户并写明。
 */
export function operatorName(env: CliEnv): string {
  const passed = env.FLEET_OPS_OPERATOR?.trim();
  if (passed) return passed.slice(0, 64);
  try {
    return `${userInfo().username}（没经 bin/fleet-api，直接跑的 node）`;
  } catch {
    return '认不出的用户（没经 bin/fleet-api，直接跑的 node）';
  }
}

// —— 入口 ——

export type CliEnv = Readonly<Record<string, string | undefined>>;

/** 命令行碰外面的几样：环境变量、输出、连库、读 GitHub、连 Temporal、钟。测试换成内存库和假的，收下输出。 */
export interface CliDeps {
  env: CliEnv;
  out(text: string): void;
  err(text: string): void;
  /** 连库，给出 Store 和关连接的办法。 */
  openStore(url: string): Promise<{ store: Store; close(): Promise<void> }>;
  now(): Date;
  /** 标准输入整段读完。不给就是真的 process.stdin。 */
  readStdin?: () => Promise<string>;
  /** 提醒的处理状态、跟进单、静默（alert 命令用）。不给就是真的：连库，法国上再读发布记录。 */
  openAlertWork?: (url: string, env: CliEnv) => Promise<{ alerts: AlertWorkPort; close(): Promise<void> }>;
  /** 意图存储（intent 命令用）。不给就是真的：连库。 */
  openIntents?: (url: string) => Promise<{ intents: IntentStore; close(): Promise<void> }>;
  /** 读一个文件（intent link 的 --summary-file）。不给就是真的。 */
  readFile?: (path: string) => Promise<string>;
  /** 生成一把新通行证明文（node-key new 用）。不给就是真随机；测试给固定的。 */
  newToken?: () => string;
  /** 任务工作流的信号和重做（task 命令用）。不给就是真的：懒连 Temporal，重做用 temporal.ts 的 taskRedo。 */
  openTaskControl?: (env: CliEnv) => Promise<OpenedTaskControl>;
}

async function openPgIntents(url: string): Promise<{ intents: IntentStore; close(): Promise<void> }> {
  const { createDb } = await import('@fleet-dao/db');
  const { withStatementTimeout } = await import('@fleet-dao/store');
  const { createPgIntentStore } = await import('./intent-store-pg.ts');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  return { intents: createPgIntentStore(db), close };
}

async function openPgStore(url: string): Promise<{ store: Store; close(): Promise<void> }> {
  // 到这里才加载库：参数不对时不用连库
  const { createDb } = await import('@fleet-dao/db');
  const { createPgStore, withStatementTimeout } = await import('@fleet-dao/store');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  return { store: createPgStore(db), close };
}

async function openPgAlertWork(
  url: string,
  env: CliEnv,
): Promise<{ alerts: AlertWorkPort; close(): Promise<void> }> {
  const { createDb } = await import('@fleet-dao/db');
  const { withStatementTimeout } = await import('@fleet-dao/store');
  const { deployFacts, pgAlertWork } = await import('@fleet-dao/store');
  const { readDeployLagInput } = await import('@fleet-dao/store');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  // 发布记录只在正式环境有（和后端 main.ts 的 deploy_lag 同一个判法：没写 FLEET_ENV 的就是正式的）
  const production = (env.FLEET_ENV ?? 'production') === 'production';
  return {
    alerts: pgAlertWork(db, () => (production ? deployFacts(readDeployLagInput()) : null)),
    close,
  };
}

export function processDeps(): CliDeps {
  return {
    env: process.env,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    openStore: openPgStore,
    now: () => new Date(),
    readStdin: readAllStdin,
    openAlertWork: openPgAlertWork,
    openIntents: openPgIntents,
    readFile: (path) => readFile(path, 'utf8'),
  };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function databaseUrl(env: CliEnv): string {
  const url = env.DATABASE_URL;
  if (!url)
    throw new CliError(
      '没有 DATABASE_URL：要带上 /etc/fleet-dao/api.env 跑（用 packages/api/bin/fleet-api）',
      2,
    );
  return url;
}

const USAGES: Record<string, string> = {
  'set-password': USAGE,
  dispatch: DISPATCH_USAGE,
  'dispatch-issue': DISPATCH_ISSUE_POINTER,
  groom: GROOM_POINTER,
  engine: ENGINE_USAGE,
  'node-key': NODE_KEY_USAGE,
  alert: ALERT_USAGE,
  intent: INTENT_USAGE,
  task: TASK_USAGE,
};

const isHelp = (arg: string | undefined) => arg === '--help' || arg === '-h';

/** 跑一条命令：返回退出码；参数不对、没做成抛 CliError（main 把它打印成一句白话）。 */
export async function runCli(argv: readonly string[], deps: CliDeps = processDeps()): Promise<number> {
  const [command, ...rest] = argv;
  // 只看用法：不连库、不碰别的（fleet-api --help 列全部，fleet-api <命令> --help 只列这一条）
  if (isHelp(command) || command === 'help') {
    deps.out(Object.values(USAGES).join('\n'));
    return 0;
  }
  const usage = command !== undefined && Object.hasOwn(USAGES, command) ? USAGES[command] : undefined;
  if (usage !== undefined && isHelp(rest[0])) {
    deps.out(usage);
    return 0;
  }
  if (command === 'set-password') {
    const args = parseSetPasswordArgs(rest);
    const { store, close } = await deps.openStore(databaseUrl(deps.env));
    const prompt = stdioPrompter();
    try {
      deps.out(await setPassword({ store, args, prompt, now: () => new Date() }));
      return 0;
    } finally {
      prompt.close();
      await close();
    }
  }
  if (command === 'dispatch' && rest[0] === '--all') {
    const args = parseDispatchAllArgs(rest);
    const { store, close } = await deps.openStore(databaseUrl(deps.env));
    try {
      deps.out(await dispatchAll({ store, args, operator: operatorName(deps.env) }));
      return 0;
    } finally {
      await close();
    }
  }
  if (command === 'dispatch') {
    const args = parseDispatchArgs(rest);
    const { store, close } = await deps.openStore(databaseUrl(deps.env));
    try {
      deps.out(await dispatch({ store, args, operator: operatorName(deps.env) }));
      return 0;
    } finally {
      await close();
    }
  }
  if (command === 'engine') {
    const args = parseEngineArgs(rest);
    const { store, close } = await deps.openStore(databaseUrl(deps.env));
    try {
      deps.out(await engine({ store, args, operator: operatorName(deps.env) }));
      return 0;
    } finally {
      await close();
    }
  }
  if (command === 'node-key') {
    const args = parseNodeKeyArgs(rest);
    const { store, close } = await deps.openStore(databaseUrl(deps.env));
    try {
      deps.out(
        await newNodeKey({ store, id: args.id, operator: operatorName(deps.env), token: deps.newToken }),
      );
      return 0;
    } finally {
      await close();
    }
  }
  if (command === 'dispatch-issue') {
    // 走到这里说明没经 bin/fleet-api（它会把这个命令转给引擎包）：不假装做了
    throw new CliError(
      'dispatch-issue 要经 packages/api/bin/fleet-api 跑（它转给引擎包的 packages/engine/src/bin/dispatch-issue.ts）',
      2,
    );
  }
  if (command === 'groom') {
    throw new CliError(
      'groom 要经 packages/api/bin/fleet-api 跑（它转给引擎包的 packages/engine/src/bin/groom.ts）',
      2,
    );
  }
  if (command === 'alert') return runAlertCommand(rest, deps);
  if (command === 'intent') return runIntentCommand(rest, deps);
  if (command === 'task') return runTaskCommand(rest, deps);
  deps.err(Object.values(USAGES).join('\n'));
  return 2;
}

/**
 * intent（#553 第 4 条）：带 --json 只往标准输出打一行 JSON（本机 pnpm intents 读），不带打给人看的话；出错也照这个样子打。
 * 参数先认完再连库（参数不对退出码 2，不连库）；连不上库、库出错退出码 1，绝不打空列表。
 */
async function runIntentCommand(rest: readonly string[], deps: CliDeps): Promise<number> {
  const json = rest.includes('--json');
  const fail = (err: IntentCliError) => {
    if (json) deps.out(JSON.stringify({ ok: false, reason: err.reason, why: err.message }));
    else deps.err(err.message);
    return err.exitCode;
  };
  let cmd: ReturnType<typeof parseIntentArgs>;
  try {
    cmd = parseIntentArgs(rest);
  } catch (err) {
    if (err instanceof IntentCliError) return fail(err);
    throw err;
  }
  let opened: { intents: IntentStore; close(): Promise<void> } | undefined;
  try {
    const url = (() => {
      try {
        return databaseUrl(deps.env);
      } catch (err) {
        throw new IntentCliError(errMessage(err), 'usage');
      }
    })();
    opened = await (deps.openIntents ?? openPgIntents)(url);
    const readStdin = deps.readStdin ?? readAllStdin;
    const read = deps.readFile ?? ((path: string) => readFile(path, 'utf8'));
    const result = await runIntent(cmd, {
      intents: opened.intents,
      readSummary: (file) => (file === '-' ? readStdin() : read(file)),
      operator: operatorName(deps.env),
    });
    deps.out(json ? JSON.stringify(result.json) : result.text);
    return result.code;
  } catch (err) {
    if (err instanceof IntentCliError) return fail(err);
    return fail(new IntentCliError(`没做成：${describeDbError(err)}`, 'error'));
  } finally {
    await opened?.close().catch(() => undefined);
  }
}

/** 用到才连：参数不对（退出码 2）的不连库。给出一个替身，第一次调方法时才打开真的（方法一律当成异步的）。 */
function lazy<T extends object>(open: () => Promise<T>): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return async (...args: unknown[]) => {
        const real = (await open()) as unknown as Record<PropertyKey, unknown>;
        const fn = real[prop];
        if (typeof fn !== 'function') throw new Error(`没有 ${String(prop)} 这个方法`);
        return (fn as (...a: unknown[]) => unknown).apply(real, args);
      };
    },
  });
}

/**
 * alert（design 15.3「谁在处理」）：带 --json 只往标准输出打一行 JSON（本机脚本读），不带打给人看的话；
 * 出错也照这个样子打。退出码见 alert-cli.ts 开头：0 好了，1 没做成（连不上库、库出错），2 参数不对。
 */
async function runAlertCommand(rest: readonly string[], deps: CliDeps): Promise<number> {
  const json = rest.includes('--json');
  const fail = (code: number, message: string) => {
    if (json) deps.out(JSON.stringify({ ok: false, reason: code === 2 ? 'usage' : 'error', why: message }));
    else deps.err(message);
    return code;
  };
  // 用到库才连：参数不对（退出码 2）的不连库
  let opened: Promise<{ store: Store; close(): Promise<void> }> | undefined;
  const connect = () => {
    opened ??= Promise.resolve().then(() => deps.openStore(databaseUrl(deps.env)));
    return opened;
  };
  const store = new Proxy({} as Store, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return async (...args: unknown[]) => {
        const real = (await connect()).store as unknown as Record<PropertyKey, unknown>;
        const fn = real[prop];
        if (typeof fn !== 'function') throw new Error(`Store 没有 ${String(prop)}`);
        return (fn as (...a: unknown[]) => unknown).apply(real, args);
      };
    },
  });
  // 提醒的那一份（alert 命令用）同样用到才连
  const openAlertWork = deps.openAlertWork ?? openPgAlertWork;
  let alertsOpened: Promise<{ alerts: AlertWorkPort; close(): Promise<void> }> | undefined;
  const alerts = lazy(async () => {
    alertsOpened ??= Promise.resolve().then(() => openAlertWork(databaseUrl(deps.env), deps.env));
    return (await alertsOpened).alerts;
  });
  try {
    const result = await runAlert(rest, { store, alerts });
    deps.out(json ? JSON.stringify(result.json) : result.text);
    return result.code;
  } catch (err) {
    if (err instanceof AlertCliError || err instanceof CliError) return fail(err.exitCode, err.message);
    return fail(1, `没做成：${describeDbError(err)}`);
  } finally {
    if (opened) await (await opened.catch(() => undefined))?.close();
    if (alertsOpened) await (await alertsOpened.catch(() => undefined))?.close();
  }
}

/** task（#1402）：参数不对不连库。做成了打到标准输出；没做成只打标准错误，不打成功那一句。 */
async function runTaskCommand(rest: readonly string[], deps: CliDeps): Promise<number> {
  if (rest.includes('--help') || rest.includes('-h')) {
    deps.out(TASK_USAGE);
    return 0;
  }
  let args: ReturnType<typeof parseTaskArgs>;
  try {
    args = parseTaskArgs(rest);
  } catch (err) {
    if (err instanceof TaskCliError) {
      deps.err(err.message);
      return err.exitCode;
    }
    throw err;
  }
  let opened: { store: Store; close(): Promise<void> } | undefined;
  let control: OpenedTaskControl | undefined;
  try {
    opened = await deps.openStore(databaseUrl(deps.env));
    control = await (deps.openTaskControl ?? openTaskControl)(deps.env);
    deps.out(
      await runTask(args, {
        store: opened.store,
        workflows: control.workflows,
        taskRedo: control.taskRedo,
        operator: operatorName(deps.env),
      }),
    );
    return 0;
  } catch (err) {
    if (err instanceof TaskCliError || err instanceof CliError) {
      deps.err(err.message);
      return err.exitCode;
    }
    deps.err(`没做成：${describeDbError(err)}`);
    return 1;
  } finally {
    await control?.close().catch(() => undefined);
    await opened?.close().catch(() => undefined);
  }
}

/** 命令行入口（src/bin/fleet-api.ts 调）：跑命令，没做成就打印一句白话，返回退出码。 */
export async function main(argv: readonly string[], deps: CliDeps = processDeps()): Promise<number> {
  try {
    return await runCli(argv, deps);
  } catch (err) {
    // set-password 的原因都接在「没设成」后面；dispatch 的每一句自己说清做到哪了
    const lead = argv[0] === 'set-password' ? '没设成：' : '';
    deps.err(`${lead}${err instanceof CliError ? err.message : String(err)}`);
    return err instanceof CliError ? err.exitCode : 1;
  }
}
