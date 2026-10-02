// 后端的管理命令（法国上以 root 经 packages/api/bin/fleet-api 跑，见 docs/ops.md 第九节「账密登录」「让 AI 接活」）。
//   set-password <飞书名或用户 id> [--username <用户名>]
// 给白名单里的人设（或重设）账密登录的密码：飞书登录出问题时也进得去驾驶舱。
// 密码只从标准输入读，读两遍要一致：终端里不回显；从管道来就读两行。不接受命令行参数传密码（会进 shell 历史和进程列表）。
// 只能给白名单里的人设（users 表里在用的创始人）；设了之后输错计数和锁清零，操作记录里写一条。
//   dispatch <owner/仓名> on|off|status
// 「让 AI 接活」开关（repos.auto_dispatch_since）：驾驶舱的开关页面（#131）之前的唯一入口，之后留作运维的后备。
// 写入口和页面同一个（Store.setAutoDispatch）；改了记一条操作记录，改完从库里读回开关和那条记录再打印。
//   handover <owner/仓名> <issue 号> --reason "<谁说的、为什么>" [--machine … --session … --term … | --founder "<创始人原话>"]
// 交给 fleet：人明说把一张自动派管不到的单（开关打开以前就开着的、别的版本的、未排期的、母单和子单、贴了「本机做」的）交给引擎，起 Fusion 工作流。
// 开关关着、这个项目停派、GitHub 上关着一律拒；在跑的不重复起，结束了的只有 GitHub 上重开过才再起一轮（判法在
// @fleet-dao/core 的 dispatch.ts）。要读 GitHub（「引擎」机器人看这张单此刻开没开着、挂在哪个版本）、连 Temporal（起工作流），
// 都按同一份 api.env。没被拒的（起了、没起成、本来就在跑）都记一条操作记录 task.handover，从库里读回再打印。
// 交单要和本机抢这张单的认领（#299）：本机认领着的拒（退出码 3），带创始人原话（--founder）才改派给引擎；帅位上线后（库里有
// main 座位）交单是受保护动作，帅位带着任期来（--machine、--session、--term，同一个事务里核），运维手敲的带 --founder。
// 驾驶舱的「交给 fleet」按钮随界面单 #282 做，调同一套判法。
//   seat …、claim …（#299 帅位只一个）：帅位接班、续约、现查、看现状、交接，帅位认领单、工人报进度和结束、作废过了宽限期的认领。
// 本机经 ssh 调，写法和退出码见 seat-cli.ts（多一个 3：不是你的——不是帅位、别人拿着、认领号对不上）。
//   alert …（design 15.3「谁在处理」）：开着的提醒谁在处理、修到哪；认领一条提醒（认领它的跟进单，就是上面的认领）；静默。
// 写法和退出码见 alert-cli.ts，和 seat、claim 一样。
// 每条命令带 --help（或 -h）只打印用法。
// 退出码（几条命令一样）：0 做成了（或本来就是）；1 没做成（被拒、库里没有、连不上库、读回来不对，一句话说原因）；2 参数不对或没带上库连接。
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import {
  claimOwnerText,
  familyGate,
  handoverDecision,
  heldByOtherText,
  localGate,
  replicaVerdict,
  versionGate,
} from '@fleet-dao/core';
import { requirementWorkflowId } from '@fleet-dao/shared';
import { ALERT_USAGE, runAlert } from './alert-cli.ts';
import type { AlertWorkPort } from './alert-work.ts';
import type { ClaimStatus } from './claim-status.ts';
import { temporalSettings } from './config.ts';
import { checkNewPassword, checkUsername, hashPassword } from './password.ts';
import type {
  AuditRecord,
  AutoDispatchChange,
  EngineClaimResult,
  IntakeRepo,
  IssuePlan,
  IssuePlanReader,
  RequirementWorkflows,
  Store,
  User,
  WorkflowControl,
} from './ports.ts';
import { CLAIM_USAGE, type ClaimCliDeps, runClaim, SeatCliError } from './seat-cli.ts';
import { isCockpitUser } from './session.ts';

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
const DISPATCH_USAGE =
  '用法：fleet-api dispatch <owner/仓名> on|off|status（「让 AI 接活」开关：on 打开，off 关上，status 只看）';

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

// —— dispatch：「让 AI 接活」开关 ——

export type DispatchAction = 'on' | 'off' | 'status';

export interface DispatchArgs {
  owner: string;
  name: string;
  action: DispatchAction;
}

/** 操作记录里开、关这两件事的名字；target 是 repo:<仓的编号>。 */
export const AUTO_DISPATCH_ENABLE = 'repo.auto_dispatch.enable';
export const AUTO_DISPATCH_DISABLE = 'repo.auto_dispatch.disable';

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
  let text = inner instanceof Error ? inner.message : String(inner);
  // IPv4、IPv6 都试过、都连不上时 Node 给的是 AggregateError：message 是空的，原因在 errors 里
  if (!text && inner instanceof AggregateError)
    text = inner.errors
      .map((e: unknown) => (e instanceof Error ? e.message : String(e)))
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
    : `${label}：让 AI 接活 开着，自 ${since} 起（这之后新开的、挂在当前版本上、没贴「本机做」的独立 issue 自动派；这之前就开着的、别的版本的、未排期的、母单和子单、贴了「本机做」的不自动派，要交用 fleet-api handover）`;
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
          reason: `服务器上 ${operator} 跑的 fleet-api dispatch ${label} ${args.action}`,
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

// —— handover：交给 fleet ——

const HANDOVER_USAGE =
  '用法：fleet-api handover <owner/仓名> <issue 号> --reason "<谁说的、为什么>" [--founder "<创始人原话>"]（把开关打开以前开的、别的版本的、未排期的、母单和子单、贴了「本机做」的交给引擎，起 Fusion 工作流。本机认领着的单要带创始人原话才改派给引擎）';

export interface HandoverArgs {
  owner: string;
  name: string;
  issueNumber: number;
  /** 谁说的、为什么交：原样写进操作记录。 */
  reason: string;
  /** 创始人原话：本机认领着的单要它才能改派给引擎。 */
  founder?: string;
}

/** 操作记录里「交给 fleet」这件事的名字；target 是 task:<任务编号>。 */
export const TASK_HANDOVER = 'task.handover';

/** 和 dispatch 一样记成引擎那一类，reason 写明谁跑的、谁说的为什么。 */
const OPS_HANDOVER = { kind: 'engine', id: 'ops:handover' } as const;

/** --reason、--founder 最长几个字：操作记录里的一句话，不是一篇文档。 */
const MAX_HANDOVER_REASON = 500;

const HANDOVER_OPTIONS = ['reason', 'founder'] as const;
type HandoverOption = (typeof HANDOVER_OPTIONS)[number];

/**
 * 仓、issue 号两个位置参数，外加必带的 --reason（也认 --reason=…）；本机认领着的要带 --founder。
 * 认不出的一律拒（退出码 2），不猜。帅位交单（--machine、--session、--term、--scope）随座位整张删掉（#531）：
 * 给了那些参数在这里就认不出。
 */
export function parseHandoverArgs(argv: readonly string[]): HandoverArgs {
  const positional: string[] = [];
  const options = new Map<HandoverOption, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') ? arg.slice(2, eq < 0 ? undefined : eq) : '';
    const known = HANDOVER_OPTIONS.find((o) => o === name);
    if (!known) throw new CliError(`认不出参数 ${arg.split('=')[0]}。${HANDOVER_USAGE}`, 2);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith('--')))
      throw new CliError(
        known === 'reason'
          ? `--reason 后面要跟一句话：谁说的、为什么交。${HANDOVER_USAGE}`
          : `--${known} 后面要跟值。${HANDOVER_USAGE}`,
        2,
      );
    if (options.has(known)) throw new CliError(`--${known} 给了两次。${HANDOVER_USAGE}`, 2);
    options.set(known, value);
  }
  if (positional.length !== 2) throw new CliError(`要两个参数：仓和 issue 号。${HANDOVER_USAGE}`, 2);
  const [repo = '', num = ''] = positional;
  const m = REPO_ARG.exec(repo);
  if (!m?.[1] || !m[2]) throw new CliError(`认不出仓「${repo}」：要写成 owner/仓名。${HANDOVER_USAGE}`, 2);
  const digits = /^#?(\d{1,9})$/.exec(num)?.[1];
  const issueNumber = digits === undefined ? 0 : Number(digits);
  if (issueNumber <= 0)
    throw new CliError(`认不出 issue 号「${num}」：要写成正整数（比如 214）。${HANDOVER_USAGE}`, 2);
  const text = (key: 'reason' | 'founder', what: string) => {
    const v = options.get(key)?.trim() ?? '';
    if ([...v].length > MAX_HANDOVER_REASON)
      throw new CliError(`--${key} 太长（最多 ${MAX_HANDOVER_REASON} 个字）：写一句${what}就行`, 2);
    return v;
  };
  const why = text('reason', '谁说的、为什么');
  if (!why) throw new CliError(`要带 --reason：谁说的、为什么交（写进操作记录）。${HANDOVER_USAGE}`, 2);
  const args: HandoverArgs = { owner: m[1], name: m[2], issueNumber, reason: why };
  if (options.has('founder')) {
    const founder = text('founder', '创始人的原话');
    if (!founder) throw new CliError(`--founder 要写创始人的原话，不能是空的。${HANDOVER_USAGE}`, 2);
    args.founder = founder;
  }
  return args;
}

/** 连 Temporal 的一份：起工作流、给工作流发信号（改派给本机时叫停引擎，#348）、用完关掉。 */
export interface HandoverTemporal {
  requirements: RequirementWorkflows;
  /** 没给（测试里只起工作流的）就叫停不了：用到时明确报错。 */
  workflows?: WorkflowControl | undefined;
  close(): Promise<void>;
}

/** 「认领对得上」那一侧（#348）连上的一份：用完关掉（它自己连库记评论、关 PR 的账）。 */
export interface ClaimsConnection {
  claims: ClaimStatus;
  close(): Promise<void>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 这张单挂在哪（给人看、写进操作记录）：交给 fleet 不看版本，但要说清交的是哪个版本的单。 */
function placeOf(issue: IssuePlan): string {
  const gate = versionGate(issue);
  const title = issue.milestone?.title ?? '';
  const where = gate.ok
    ? `挂在当前版本「${gate.milestone}」上`
    : gate.reason === 'unscheduled'
      ? '未排期'
      : gate.reason === 'version_unreadable'
        ? `挂在「${title}」上（认不出版本号）`
        : `挂在「${title}」上（不是当前版本）`;
  // 母单、子单自动派不派（#252 之前），交了照起：说清交的是哪一种，母单和子单别同时交（会抢同一批文件）
  const family = familyGate(issue);
  const kind = family.ok
    ? where
    : family.reason === 'mother_ticket'
      ? `${where}，是母单${issue.subIssues > 0 ? `、下面挂着 ${issue.subIssues} 张子单` : ''}`
      : `${where}，是 #${issue.parent} 下面的子单`;
  // 贴着「本机做」的（#299 止血）自动派不派，明着交了照起：说清交出去的这张帅位原本留给本机、标签还贴着
  return localGate(issue).ok ? kind : `${kind}，贴着「本机做」（帅位原本留给本机做的）`;
}

/**
 * fleet-api handover 本身。依次查、不对就拒（什么都不改，退出码 1）：仓在库里；「让 AI 接活」开着；流程配置副本能用；
 * 库里有这张单的任务行；GitHub 上这张单此刻的样子（读不到算没查成；关着的拒）。再按 core 的 handoverDecision：排队中的拉起、
 * 结束了又重开过的再起一轮；在跑的不重复起（退出码 0）。真交了的（起了、没起成、本来就在跑）都记一条 task.handover
 * （谁跑的、谁说的为什么），从库里读回再打印。GitHub、Temporal 到用得着时才连（plans、temporal 是开连接的办法）：
 * 前面就拒了的不连，在跑的不连 Temporal。
 */
export async function handover(input: {
  store: Store;
  plans: () => Promise<IssuePlanReader>;
  temporal: () => Promise<HandoverTemporal>;
  /** 强制改派作废了本机的认领时，它开着的 PR 撤自动合并、关掉、留言（#348）。没给的照实打出来要人补。 */
  claims?: (() => Promise<ClaimStatus>) | undefined;
  args: HandoverArgs;
  operator: string;
  now: () => Date;
}): Promise<string> {
  const { store, args } = input;
  const no = '没交成（什么都没派）：';
  const found = await dbStep(no, () => store.findRepoByName(args.owner, args.name));
  if (!found)
    throw new CliError(
      `${no}库里没有仓 ${args.owner}/${args.name}（受管的仓就是 repos 表的行，见 docs/ops.md 第九节）`,
    );
  const repo: IntakeRepo = found;
  const slug = `${repo.owner}/${repo.name}`;
  const label = `${slug}#${args.issueNumber}`;
  if (repo.autoDispatchSince === null)
    throw new CliError(
      `${no}${slug} 的「让 AI 接活」关着：关着时引擎只收单、显示，不派，交了也不起。要交先打开（fleet-api dispatch ${slug} on，开不开由创始人拍）`,
    );
  const flow = replicaVerdict(repo.flow, input.now());
  if (!flow.ok) throw new CliError(`${no}这个项目停派：${flow.why}`);
  const task = await dbStep(no, () => store.findTaskByIssue(repo.id, args.issueNumber));
  if (!task)
    throw new CliError(
      `${no}库里没有 ${label} 的任务：接活还没收进来（不是 issue、作者不在白名单、已经关了，或对账还没补收）。GitHub 上开着、作者在白名单的单，等下一轮对账（每 15 分钟）补收了再交`,
    );
  let issue: IssuePlan;
  try {
    issue = await (await input.plans()).read(repo, args.issueNumber);
  } catch (err) {
    throw new CliError(`${no}没查成：读不到 GitHub 上 ${label} 此刻的样子（${errText(err)}）`);
  }
  const decision = handoverDecision(task, issue);
  const place = placeOf(issue);
  if (decision.act === 'refuse') throw new CliError(`${no}${label}（${place}）：${decision.why}`);

  const restart = decision.act === 'restart';
  const workflowId = requirementWorkflowId(repo, args.issueNumber);
  const who = args.founder ? `（创始人原话：${args.founder}）` : '';
  // 认领（#299，方案第四节）：交单也和本机（帅位、工人）抢库里同一行。帅位座位整张删掉（#531）后，交单只剩运维
  // 这一路：要打创始人原话才能越过仍活着的本机认领。
  let claimed: Extract<EngineClaimResult, { ok: true }> | undefined;
  if (decision.act !== 'noop') {
    const r = await dbStep(no, () =>
      store.claimForEngine({
        repoId: repo.id,
        issueNumber: args.issueNumber,
        workflowId,
        actor: OPS_HANDOVER,
        founder: args.founder,
        note: `交给 fleet${who}：${args.reason}`,
      }),
    );
    if (!r.ok) {
      throw new CliError(
        `${no}${label}（${place}）${heldByOtherText(r.claim, r.now)}。要改派给引擎，带上创始人原话 --founder "…"：本机那份认领当场作废`,
        3,
      );
    }
    claimed = r;
  }
  let started: 'started' | 'already_running' | undefined;
  let failure: string | undefined;
  if (decision.act !== 'noop') {
    // 开关、副本都不进工作流的历史（和接活拉起的是同一种输入）
    const { autoDispatchSince: _switch, flow: _flow, ...repoOnly } = repo;
    try {
      const temporal = await input.temporal();
      try {
        started = await temporal.requirements.start({
          schemaVersion: 1,
          taskId: task.id,
          repo: repoOnly,
          issueNumber: args.issueNumber,
          title: task.title,
          rawRequest: task.rawRequest,
          requestedBy: issue.author ?? task.requestedBy,
        });
      } finally {
        // 只是收尾：关连接出错不改「起没起成」（起成了的照样算起了），命令跑完进程就退
        await temporal.close().catch(() => {});
      }
    } catch (err) {
      failure = `起工作流没成：${errText(err)}`;
    }
    // 重开过的再起一轮，上一轮工作流却还在收尾：这次没起
    if (restart && started === 'already_running')
      failure = '上一轮工作流还没收完尾，这次没起：等它结束了再交一次';
  }
  // 认领跟着起没起成走：起了（或本来就在跑）改在做；这次新认领的没起成就放下（这次什么都没派，本机能接着认领）。
  // 这两步只是收尾：没写上照样往下记操作记录，写明没写上（起了的工作流写第一份快照时也会把认领改成在做）
  const claimNotes: string[] = [];
  if (claimed) {
    const target = { repoId: repo.id, issueNumber: args.issueNumber };
    const id = claimed.claim.claimId.slice(0, 8);
    try {
      if (!failure) {
        await store.startEngineClaim(target);
        claimNotes.push(`归引擎（认领 ${id}）`);
      } else if (claimed.fresh) {
        await store.releasePendingEngineClaim({
          ...target,
          claimId: claimed.claim.claimId,
          reason: `交单时${failure}`,
          actor: OPS_HANDOVER,
        });
        claimNotes.push(`这次新认领的（认领 ${id}）已放下`);
      }
    } catch (err) {
      claimNotes.push(`认领 ${id} 没改成（${errText(err)}）`);
    }
    const v = claimed.voided;
    if (v) {
      const head = `作废了本机的认领（原来归 ${claimOwnerText(v)}，认领 ${v.claimId.slice(0, 8)}）`;
      // 它开着的 PR：撤自动合并、关掉（分支留着）、留言指向引擎；没做成的照实写，要人补
      try {
        if (!input.claims) throw new Error('这里没接 GitHub');
        const closed = await (await input.claims()).closeForReassign(repo, v, {
          to: '引擎',
          why: `创始人原话：${args.founder ?? ''}`,
        });
        claimNotes.push(
          `${head}${closed.closed.length > 0 ? `，它开着的 PR ${closed.closed.map((n) => `#${n}`).join('、')} 撤了自动合并、关了（分支留着）` : '，它没有开着的 PR'}${closed.problems.length > 0 ? `；没处理成：${closed.problems.join('；')}` : ''}`,
        );
      } catch (err) {
        claimNotes.push(
          `${head}；它开着的 PR 没处理（${errText(err)}）${v.prNumbers.length > 0 ? `，登记过的 ${v.prNumbers.map((n) => `#${n}`).join('、')} 要人撤自动合并、关掉` : ''}`,
        );
      }
    }
  }
  const outcome =
    decision.act === 'noop'
      ? 'in_progress'
      : failure
        ? 'failed'
        : started === 'already_running'
          ? 'already_running'
          : 'started';

  // 真交了的都记（谁跑的、谁说的为什么、挂在哪个版本、上一轮什么状态、起没起成）；记完从库里读回
  const target = `task:${task.id}`;
  const note = `服务器上 ${input.operator} 跑的 fleet-api handover ${slug} ${args.issueNumber}${who}：${args.reason}`;
  // 认领另起一行（在操作记录那行前面）
  const claimLine = claimNotes.length > 0 ? `\n认领：${claimNotes.join('；')}` : '';
  const done =
    decision.act === 'noop'
      ? `没起：${label}（${place}）${decision.why}`
      : outcome === 'failed'
        ? `没交成：${label}（${place}）${failure}`
        : outcome === 'started'
          ? `已交给 fleet：${label}（${place}）${restart ? `上一轮是 ${task.state}、GitHub 上重开过，再` : ''}起了 Fusion 工作流 ${workflowId}`
          : `已交给 fleet：${label}（${place}）工作流 ${workflowId} 已经在跑（刚被别处拉起），没重复起`;
  const auditId = await dbStep(
    outcome === 'failed' ? `${done}；操作记录也没写进去：` : `${done}，但操作记录没写进去：`,
    () =>
      store.appendAudit({
        actor: OPS_HANDOVER,
        action: TASK_HANDOVER,
        target,
        before: { state: task.state },
        after: {
          workflowId,
          outcome,
          restart,
          milestone: issue.milestone?.title ?? null,
          parent: issue.parent,
          subIssues: issue.subIssues,
          place,
          claim: claimed
            ? {
                claimId: claimed.claim.claimId,
                fresh: claimed.fresh,
                voided: claimed.voided?.claimId ?? null,
              }
            : null,
        },
        reason: note,
        via: 'engine',
        ok: outcome !== 'failed',
        ...(failure ? { error: failure } : {}),
      }),
  );
  const page = await dbStep(`${done}（操作记录 ${auditId}），但读回时`, () =>
    store.listAudit({ target, limit: RECENT_AUDITS }),
  );
  const entry = page.items.find((a) => a.id === auditId);
  if (!entry) throw new CliError(`${done}（操作记录 ${auditId}），但读回时库里找不到这条操作记录`);
  const record = `操作记录 ${entry.id}：${entry.at} ${entry.reason ?? note}`;
  if (outcome === 'failed') throw new CliError(`${done}${claimLine}\n${record}`);
  return `${done}${claimLine}\n${record}`;
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
  /** 读 issue 此刻的样子（handover 用）：「引擎」机器人，凭据按环境里的位置读（和 fleet-api.service 同一份）。 */
  openIssuePlans(env: CliEnv): Promise<IssuePlanReader>;
  /** 连 Temporal 起工作流（handover 用）：地址、命名空间、任务队列按环境读（config.ts 的 temporalSettings）。 */
  openTemporal(env: CliEnv): Promise<HandoverTemporal>;
  now(): Date;
  /** 标准输入整段读完。不给就是真的 process.stdin。 */
  readStdin?: () => Promise<string>;
  /** 提醒的处理状态、跟进单、静默（alert 命令用）。不给就是真的：连库，法国上再读发布记录。 */
  openAlertWork?: (url: string, env: CliEnv) => Promise<{ alerts: AlertWorkPort; close(): Promise<void> }>;
  /**
   * 「认领对得上」那一侧（#348，claim、handover 用）：「引擎」机器人（凭据和 fleet-api.service 同一份）加一个连库（评论、关 PR
   * 记账）。不给的用到时明确报错，不当成贴上了。
   */
  openClaims?: (url: string, env: CliEnv) => Promise<ClaimsConnection>;
}

async function openPgStore(url: string): Promise<{ store: Store; close(): Promise<void> }> {
  // 到这里才加载库：参数不对时不用连库
  const { createDb } = await import('@fleet-dao/db');
  const { createPgStore, withStatementTimeout } = await import('./pg-store.ts');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  return { store: createPgStore(db), close };
}

async function openPgAlertWork(
  url: string,
  env: CliEnv,
): Promise<{ alerts: AlertWorkPort; close(): Promise<void> }> {
  const { createDb } = await import('@fleet-dao/db');
  const { withStatementTimeout } = await import('./pg-store.ts');
  const { deployFacts, pgAlertWork } = await import('./alert-work.ts');
  const { readDeployLagInput } = await import('./deploy-lag.ts');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  // 发布记录只在法国的正式机器上有（和后端 main.ts 的 deploy_lag 同一个判法：没写 FLEET_ENV 的就是正式的）
  const production = (env.FLEET_ENV ?? 'production') === 'production';
  return {
    alerts: pgAlertWork(db, () => (production ? deployFacts(readDeployLagInput()) : null)),
    close,
  };
}

async function openPgClaims(url: string, env: CliEnv): Promise<ClaimsConnection> {
  // 用得着才加载、才读凭据：凭据读不到抛 GitHubError（只带文件路径，不带内容）
  const { createDb } = await import('@fleet-dao/db');
  const { createGitHub, pgLedger, pgLocker } = await import('@fleet-dao/github');
  const { createPgStore, withStatementTimeout } = await import('./pg-store.ts');
  const { createClaimStatus } = await import('./claim-status.ts');
  const { silentLogger } = await import('./log.ts');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  try {
    const gh = createGitHub({ ledger: pgLedger(db), locker: pgLocker(db), env });
    return {
      claims: createClaimStatus({ store: createPgStore(db), github: gh.claims, log: silentLogger }),
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

async function openGitHubPlans(env: CliEnv): Promise<IssuePlanReader> {
  // 用得着才加载、才读凭据：前面就拒了的不碰；凭据读不到抛 GitHubError（只带文件路径，不带内容）
  const { appFilesFromEnv, GitHubClient, loadApps, readIssuePlan } = await import('@fleet-dao/github');
  const client = new GitHubClient({ apps: loadApps(appFilesFromEnv(env)) });
  return {
    read: (repo, issueNumber) =>
      readIssuePlan(client, { repo: { owner: repo.owner, name: repo.name }, issueNumber }),
  };
}

async function openTemporalClient(env: CliEnv): Promise<HandoverTemporal> {
  // 懒连接：这一步不连网络，起工作流时才连，连不上、5 秒没回应抛 WorkflowUnavailableError
  const { connectTemporal } = await import('./temporal.ts');
  const s = temporalSettings(env);
  const t = connectTemporal({
    address: s.temporalAddress,
    namespace: s.temporalNamespace,
    taskQueue: s.fleetTaskQueue,
  });
  return { requirements: t.requirements, workflows: t.control, close: () => t.close() };
}

export function processDeps(): CliDeps {
  return {
    env: process.env,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    openStore: openPgStore,
    openIssuePlans: openGitHubPlans,
    openTemporal: openTemporalClient,
    now: () => new Date(),
    readStdin: readAllStdin,
    openAlertWork: openPgAlertWork,
    openClaims: openPgClaims,
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
  handover: HANDOVER_USAGE,
  claim: CLAIM_USAGE,
  alert: ALERT_USAGE,
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
  if (command === 'handover') {
    const args = parseHandoverArgs(rest);
    const { store, close } = await deps.openStore(databaseUrl(deps.env));
    const claims = claimsOnDemand(deps);
    try {
      deps.out(
        await handover({
          store,
          plans: () => deps.openIssuePlans(deps.env),
          temporal: () => deps.openTemporal(deps.env),
          claims: claims.get,
          args,
          operator: operatorName(deps.env),
          now: () => deps.now(),
        }),
      );
      return 0;
    } finally {
      await claims.close();
      await close();
    }
  }
  if (command === 'claim' || command === 'alert') return runSeatOrClaim(command, rest, deps);
  deps.err(Object.values(USAGES).join('\n'));
  return 2;
}

/** 「认领对得上」那一侧用到才连（#348）：没接（openClaims 没给）的用到时抛错，不当成贴上了；用完 close。 */
function claimsOnDemand(deps: CliDeps): { get: () => Promise<ClaimStatus>; close(): Promise<void> } {
  let opened: Promise<ClaimsConnection> | undefined;
  return {
    get: async () => {
      const open = deps.openClaims;
      if (!open) throw new CliError('这里没接 GitHub（openClaims），贴不了「认领对得上」', 1);
      opened ??= Promise.resolve().then(() => open(databaseUrl(deps.env), deps.env));
      return (await opened).claims;
    },
    close: async () => {
      if (!opened) return;
      const c = await opened.catch(() => undefined);
      await c?.close();
    },
  };
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
 * claim（#299）、alert（design 15.3「谁在处理」）：带 --json 只往标准输出打一行 JSON（本机脚本读），不带打给人看的话；
 * 出错也照这个样子打。退出码见 seat-cli.ts 开头：0 好了，3 不是你的，1 没做成（连不上库、库出错），2 参数不对。
 */
async function runSeatOrClaim(
  command: 'claim' | 'alert',
  rest: readonly string[],
  deps: CliDeps,
): Promise<number> {
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
  // 认领那几样外面的（#348）：GitHub 用到才连
  const claims = claimsOnDemand(deps);
  const claimDeps: ClaimCliDeps = {
    store,
    claims: claims.get,
  };
  try {
    const result =
      command === 'claim' ? await runClaim(rest, claimDeps) : await runAlert(rest, { store, alerts });
    deps.out(json ? JSON.stringify(result.json) : result.text);
    return result.code;
  } catch (err) {
    if (err instanceof SeatCliError || err instanceof CliError) return fail(err.exitCode, err.message);
    return fail(1, `没做成：${describeDbError(err)}`);
  } finally {
    if (opened) await (await opened.catch(() => undefined))?.close();
    if (alertsOpened) await (await alertsOpened.catch(() => undefined))?.close();
    await claims.close();
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
