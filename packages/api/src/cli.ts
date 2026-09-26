// 后端的管理命令（法国上以 root 经 packages/api/bin/fleet-api 跑，见 docs/ops.md 第九节「账密登录」）。
//   set-password <飞书名或用户 id> [--username <用户名>]
// 给白名单里的人设（或重设）账密登录的密码：飞书登录出问题时也进得去驾驶舱。
// 密码只从标准输入读，读两遍要一致：终端里不回显；从管道来就读两行。不接受命令行参数传密码（会进 shell 历史和进程列表）。
// 只能给白名单里的人设（users 表里在用的创始人）；设了之后输错计数和锁清零，操作记录里写一条。
import { createInterface } from 'node:readline';
import { checkNewPassword, checkUsername, hashPassword } from './password.ts';
import type { Store, User } from './ports.ts';
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

/** 命令行入口（src/bin/fleet-api.ts 调）：返回退出码；CliError 由调用方打印成一句白话。 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'set-password') {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const args = parseSetPasswordArgs(rest);
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new CliError(
      '没有 DATABASE_URL：要带上 /etc/fleet-dao/api.env 跑（用 packages/api/bin/fleet-api）',
      2,
    );
  // 到这里才加载库：参数不对时不用连库
  const { createDb } = await import('@fleet-dao/db');
  const { createPgStore, withStatementTimeout } = await import('./pg-store.ts');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  const prompt = stdioPrompter();
  try {
    const message = await setPassword({ store: createPgStore(db), args, prompt, now: () => new Date() });
    process.stdout.write(`${message}\n`);
    return 0;
  } finally {
    prompt.close();
    await close();
  }
}
