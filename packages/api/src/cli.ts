// 后端的管理命令（法国上以 root 经 packages/api/bin/fleet-api 跑，见 docs/ops.md 第九节「账密登录」「让 AI 接活」）。
//   set-password <飞书名或用户 id> [--username <用户名>]
// 给白名单里的人设（或重设）账密登录的密码：飞书登录出问题时也进得去驾驶舱。
// 密码只从标准输入读，读两遍要一致：终端里不回显；从管道来就读两行。不接受命令行参数传密码（会进 shell 历史和进程列表）。
// 只能给白名单里的人设（users 表里在用的创始人）；设了之后输错计数和锁清零，操作记录里写一条。
//   dispatch <owner/仓名> on|off|status
// 「让 AI 接活」开关（repos.auto_dispatch_since）：驾驶舱的开关页面（#131）之前的唯一入口，之后留作运维的后备。
// 写入口和页面同一个（Store.setAutoDispatch）；改了记一条操作记录，改完从库里读回开关和那条记录再打印。
//   handover <owner/仓名> <issue 号> --reason "<谁说的、为什么>"
// 交给 fleet：人明说把一张自动派管不到的单（开关打开以前就开着的、别的版本的、未排期的）交给引擎，起 Fusion 工作流。
// 开关关着、这个项目停派一律拒；在跑的不重复起，结束了的只有 GitHub 上重开过才再起一轮（判法在 @fleet-dao/core 的 dispatch.ts）。
// 要读 GitHub（「引擎」机器人看这张单此刻开没开着、挂在哪个版本）、连 Temporal（起工作流），都按同一份 api.env。
// 起了（或没起成）记一条操作记录 task.handover，从库里读回再打印。驾驶舱的「交给 fleet」按钮随界面单 #282 做，调同一套判法。
// 每条命令带 --help（或 -h）只打印用法。
// 退出码（几条命令一样）：0 做成了（或本来就是）；1 没做成（被拒、库里没有、连不上库、读回来不对，一句话说原因）；2 参数不对或没带上库连接。
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { handoverDecision, replicaVerdict, versionGate } from '@fleet-dao/core';
import { requirementWorkflowId } from '@fleet-dao/shared';
import { temporalSettings } from './config.ts';
import { checkNewPassword, checkUsername, hashPassword } from './password.ts';
import type {
  AuditRecord,
  AutoDispatchChange,
  IntakeRepo,
  IssuePlan,
  IssuePlanReader,
  RequirementWorkflows,
  Store,
  User,
} from './ports.ts';
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
    : `${label}：让 AI 接活 开着，自 ${since} 起（这之后新开的、挂在当前版本上的 issue 自动派；这之前就开着的、别的版本的、未排期的不自动派，要交用 fleet-api handover）`;
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
  '用法：fleet-api handover <owner/仓名> <issue 号> --reason "<谁说的、为什么>"（把开关打开以前开的、别的版本的、未排期的单交给引擎，起 Fusion 工作流）';

export interface HandoverArgs {
  owner: string;
  name: string;
  issueNumber: number;
  /** 谁说的、为什么交：原样写进操作记录。 */
  reason: string;
}

/** 操作记录里「交给 fleet」这件事的名字；target 是 task:<任务编号>。 */
export const TASK_HANDOVER = 'task.handover';

/** 和 dispatch 一样记成引擎那一类，reason 写明谁跑的、谁说的为什么。 */
const OPS_HANDOVER = { kind: 'engine', id: 'ops:handover' } as const;

/** --reason 最长几个字：操作记录里的一句话，不是一篇文档。 */
const MAX_HANDOVER_REASON = 500;

/** 仓、issue 号两个位置参数，外加必带的 --reason（也认 --reason=…）。认不出的一律拒（退出码 2），不猜。 */
export function parseHandoverArgs(argv: readonly string[]): HandoverArgs {
  const positional: string[] = [];
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--reason') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new CliError(`--reason 后面要跟一句话：谁说的、为什么交。${HANDOVER_USAGE}`, 2);
      reason = value;
    } else if (arg.startsWith('--reason=')) {
      reason = arg.slice('--reason='.length);
    } else if (arg.startsWith('-')) {
      throw new CliError(`认不出参数 ${arg.split('=')[0]}。${HANDOVER_USAGE}`, 2);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) throw new CliError(`要两个参数：仓和 issue 号。${HANDOVER_USAGE}`, 2);
  const [repo = '', num = ''] = positional;
  const m = REPO_ARG.exec(repo);
  if (!m?.[1] || !m[2]) throw new CliError(`认不出仓「${repo}」：要写成 owner/仓名。${HANDOVER_USAGE}`, 2);
  const digits = /^#?(\d{1,9})$/.exec(num)?.[1];
  const issueNumber = digits === undefined ? 0 : Number(digits);
  if (issueNumber <= 0)
    throw new CliError(`认不出 issue 号「${num}」：要写成正整数（比如 214）。${HANDOVER_USAGE}`, 2);
  const why = reason?.trim() ?? '';
  if (!why) throw new CliError(`要带 --reason：谁说的、为什么交（写进操作记录）。${HANDOVER_USAGE}`, 2);
  if ([...why].length > MAX_HANDOVER_REASON)
    throw new CliError(`--reason 太长（最多 ${MAX_HANDOVER_REASON} 个字）：写一句谁说的、为什么就行`, 2);
  return { owner: m[1], name: m[2], issueNumber, reason: why };
}

/** 连 Temporal 的一份：起工作流、用完关掉。 */
export interface HandoverTemporal {
  requirements: RequirementWorkflows;
  close(): Promise<void>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 这张单挂在哪（给人看、写进操作记录）：交给 fleet 不看版本，但要说清交的是哪个版本的单。 */
function placeOf(issue: IssuePlan): string {
  const gate = versionGate(issue);
  if (gate.ok) return `挂在当前版本「${gate.milestone}」上`;
  if (gate.reason === 'unscheduled') return '未排期';
  const title = issue.milestone?.title ?? '';
  return gate.reason === 'version_unreadable'
    ? `挂在「${title}」上（认不出版本号）`
    : `挂在「${title}」上（不是当前版本）`;
}

/**
 * fleet-api handover 本身。依次查、不对就拒（什么都不改，退出码 1）：仓在库里；「让 AI 接活」开着；流程配置副本能用；
 * 库里有这张单的任务行；GitHub 上这张单此刻的样子（读不到算没查成）。再按 core 的 handoverDecision：排队中的拉起、
 * 结束了又重开过的再起一轮；在跑的不重复起（退出码 0）。起了（或没起成）记一条 task.handover，从库里读回再打印。
 * GitHub、Temporal 到用得着时才连（plans、temporal 是开连接的办法）：前面就拒了的不连。
 */
export async function handover(input: {
  store: Store;
  plans: () => Promise<IssuePlanReader>;
  temporal: () => Promise<HandoverTemporal>;
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
  if (decision.act === 'noop') return `没起：${label}（${place}）${decision.why}`;

  const restart = decision.act === 'restart';
  const workflowId = requirementWorkflowId(repo, args.issueNumber);
  // 开关、副本都不进工作流的历史（和接活拉起的是同一种输入）
  const { autoDispatchSince: _switch, flow: _flow, ...repoOnly } = repo;
  let started: 'started' | 'already_running' | undefined;
  let failure: string | undefined;
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
  const outcome = failure ? 'failed' : started === 'already_running' ? 'already_running' : 'started';

  // 起了、没起成都记（谁跑的、谁说的为什么、挂在哪个版本、上一轮什么状态）；记完从库里读回
  const target = `task:${task.id}`;
  const note = `服务器上 ${input.operator} 跑的 fleet-api handover ${slug} ${args.issueNumber}：${args.reason}`;
  const done =
    outcome === 'failed'
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
          place,
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
  if (outcome === 'failed') throw new CliError(`${done}\n${record}`);
  return `${done}\n${record}`;
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
}

async function openPgStore(url: string): Promise<{ store: Store; close(): Promise<void> }> {
  // 到这里才加载库：参数不对时不用连库
  const { createDb } = await import('@fleet-dao/db');
  const { createPgStore, withStatementTimeout } = await import('./pg-store.ts');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  return { store: createPgStore(db), close };
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
  return { requirements: t.requirements, close: () => t.close() };
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
  };
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
    try {
      deps.out(
        await handover({
          store,
          plans: () => deps.openIssuePlans(deps.env),
          temporal: () => deps.openTemporal(deps.env),
          args,
          operator: operatorName(deps.env),
          now: () => deps.now(),
        }),
      );
      return 0;
    } finally {
      await close();
    }
  }
  deps.err(Object.values(USAGES).join('\n'));
  return 2;
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
