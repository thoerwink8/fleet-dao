// pnpm intents（#553 PR-4）：指挥官在本机读飞书里的意图——经已有的 ssh 在法国跑 `fleet-api intent list|show --json`，
// 按 shared 里的约定（IntentCli*）认回来，再打给人看。入口在 bin/intents.ts。
//   pnpm intents [list] [--all] [--json]    还没处理的意图（--all 连已开成单、已放下的一起）
//   pnpm intents show <号> [--json]         一段意图的全部原话
// 退出码：0 读成了（读成了而且一条都没有，也是 0，会明写「0 条」）；1 读不到（连不上、超时、法国上没跑成、回来的认不出）；
//         2 参数不对，或这台没配登法国的 ssh 名字。
// 改这里之前必须知道：
// - 读不到一律非 0、打「读不到：原因」，**绝不打「没有未处理」或空列表冒充**：「0 条」只在读成功、解析认得、列表真空时才写
//   （方案 C1–C4，packages/conventions/test/intents.test.ts 钉着）。--json 时读不到也打一行 {ok:false,reason,why}，不打 []。
// - 原话原样、一个字不改；AI 归纳只来自法国库里的归纳字段（指挥官开单时写回的），单独成行、标明不是原话。
// - ssh 名字的读法和 agents/skills/commander/scripts/france-lib.mjs 的 readTarget 是同一条路（环境变量 FLEET_FRANCE_SSH，
//   其次 ~/.fleet-dao/france-ssh 第一行）；那份是装到各机器上纯 node 跑的，这里不能引用，两份改一份要看一眼另一份。
// - 法国上命令参数只由这里拼，意图号只认正整数，不把用户输入原样塞进远程 shell。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IntentCliFailure, IntentCliListOutput, IntentCliShowOutput } from '@fleet-dao/shared';

export const FRANCE_SSH_ENV = 'FLEET_FRANCE_SSH';
/** 法国上后端管理命令的位置（docs/ops.md 第九节）；ssh 以 root 进去跑。 */
export const REMOTE_FLEET_API = '/srv/fleet-dao-releases/current/packages/api/bin/fleet-api';
export const SSH_TIMEOUT_MS = 60_000;
/** 一次最多收多少字节：再多当成出了问题，不收。 */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** 列表一次读多少段（fleet-api 的上限）。 */
const LIST_LIMIT = 500;

export const INTENTS_USAGE = `用法：pnpm intents [list] [--all] [--json]    还没处理的意图（--all：连已开成单、已放下的一起）
      pnpm intents show <号> [--json]       一段意图的全部原话
登法国的 ssh 名字：环境变量 ${FRANCE_SSH_ENV}，或 ~/.fleet-dao/france-ssh 的第一行。
退出码：0 读成了；1 读不到（原因写在「读不到：」后面）；2 参数不对或没配 ssh。`;

export type IntentsReason =
  | 'usage'
  | 'not-configured'
  | 'ssh-failed'
  | 'timeout'
  | 'remote-failed'
  | 'bad-shape';

export class IntentsError extends Error {
  readonly reason: IntentsReason;
  readonly exitCode: number;
  constructor(reason: IntentsReason, message: string) {
    super(message);
    this.name = 'IntentsError';
    this.reason = reason;
    this.exitCode = reason === 'usage' || reason === 'not-configured' ? 2 : 1;
  }
}

export type IntentsCommand =
  | { kind: 'list'; all: boolean; json: boolean }
  | { kind: 'show'; seq: number; json: boolean };

/** 认不出的参数一律拒，不猜。 */
export function parseIntentsArgs(argv: readonly string[]): IntentsCommand {
  const json = argv.includes('--json');
  const rest = argv.filter((a) => a !== '--json');
  const [first, ...more] = rest;
  const implicitList = first === undefined || first.startsWith('--');
  const sub = implicitList ? 'list' : first;
  const args = implicitList ? rest : more;
  const bad = (why: string) => new IntentsError('usage', `${why}。\n${INTENTS_USAGE}`);
  if (sub === 'list') {
    const unknown = args.filter((a) => a !== '--all');
    if (unknown.length > 0) throw bad(`list 不认 ${unknown.join('、')}`);
    return { kind: 'list', all: args.includes('--all'), json };
  }
  if (sub === 'show') {
    if (args.length !== 1 || !/^[1-9]\d{0,8}$/.test(args[0] ?? '')) {
      throw bad(`show 要且只要一个意图号（正整数），收到 ${args.length === 0 ? '空' : args.join(' ')}`);
    }
    return { kind: 'show', seq: Number(args[0]), json };
  }
  throw bad(`认不出子命令 ${sub}`);
}

// —— ssh 名字 ——

const errCode = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function checkHost(host: string, from: string): string {
  // 不许以横线开头：挡住被 ssh 当成选项（-oProxyCommand=…）
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,200}$/.test(host)) {
    throw new IntentsError(
      'not-configured',
      `${from} 里的 ssh 名字认不出：只许字母、数字、点、横线、下划线、@，不许以横线开头`,
    );
  }
  return host;
}

export interface TargetIo {
  env: Record<string, string | undefined>;
  home: string;
  readText(file: string): string;
}

export function readSshTarget({ env, home, readText }: TargetIo): string {
  const fromEnv = env[FRANCE_SSH_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return checkHost(fromEnv.trim(), `环境变量 ${FRANCE_SSH_ENV}`);
  }
  const file = join(home, '.fleet-dao', 'france-ssh');
  let text: string;
  try {
    text = readText(file);
  } catch (e) {
    if (errCode(e) === 'ENOENT') {
      throw new IntentsError(
        'not-configured',
        `这台机器没配法国 ssh：在 ${file} 写一行 ~/.ssh/config 里的 Host 名（或设环境变量 ${FRANCE_SSH_ENV}）`,
      );
    }
    throw new IntentsError('not-configured', `${file} 读不了（${errCode(e) ?? errText(e)}）`);
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  if (!line) throw new IntentsError('not-configured', `${file} 是空的：写一行 ~/.ssh/config 里的 Host 名`);
  return checkHost(line, file);
}

// —— 经 ssh 跑 ——

/** 法国上要跑的那条命令（只由这里拼）。 */
export function remoteCommand(cmd: IntentsCommand): string {
  const tail =
    cmd.kind === 'list'
      ? `intent list --status ${cmd.all ? 'all' : 'new'} --limit ${LIST_LIMIT} --json`
      : `intent show ${cmd.seq} --json`;
  return `bash ${REMOTE_FLEET_API} ${tail}`;
}

export function sshArgs(host: string, remote: string): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'Compression=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=3',
    host,
    remote,
  ];
}

/** ssh 跑完的样子：code 是 ssh 的退出码（255 是 ssh 自己连不上；别的是远程命令的）；起不来、超时抛 IntentsError。 */
export interface RemoteRun {
  code: number;
  stdout: string;
  stderr: string;
}
export type RunRemote = (host: string, remote: string) => Promise<RemoteRun>;

const lastLines = (text: string, n = 2) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' / ');

export const sshRunner =
  (timeoutMs = SSH_TIMEOUT_MS, command = 'ssh'): RunRemote =>
  (host, remote) =>
    new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, sshArgs(host, remote), {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        reject(new IntentsError('ssh-failed', `起不了 ssh（${errCode(e) ?? errText(e)}）`));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let timedOut = false;
      let tooBig = false;
      let settled = false;
      const settle = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        f();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.on('error', (e) =>
        settle(() =>
          reject(
            new IntentsError(
              'ssh-failed',
              errCode(e) === 'ENOENT'
                ? `本机找不到 ${command} 命令：装上 OpenSSH 客户端、放进 PATH`
                : `ssh 没起来（${errCode(e) ?? errText(e)}）`,
            ),
          ),
        ),
      );
      child.stdout?.on('data', (d: Buffer) => {
        outBytes += d.length;
        if (outBytes > MAX_OUTPUT_BYTES) {
          tooBig = true;
          child.kill();
        } else out.push(d);
      });
      child.stderr?.on('data', (d: Buffer) => {
        errBytes += d.length;
        if (errBytes <= 64 * 1024) err.push(d);
      });
      child.on('close', (code, signal) =>
        settle(() => {
          if (timedOut) {
            reject(
              new IntentsError(
                'timeout',
                `ssh ${Math.round(timeoutMs / 1000)} 秒没回完（连不上法国，或法国上读得太慢），已经停了`,
              ),
            );
          } else if (tooBig) {
            reject(new IntentsError('bad-shape', `法国回来的超过 ${MAX_OUTPUT_BYTES} 字节，不收`));
          } else if (code === null) {
            reject(new IntentsError('ssh-failed', `ssh 被信号 ${signal} 停了`));
          } else {
            resolve({
              code,
              stdout: Buffer.concat(out).toString('utf8'),
              stderr: Buffer.concat(err).toString('utf8'),
            });
          }
        }),
      );
    });

// —— 回来的认不认得 ——

type ShowOutput = ReturnType<typeof IntentCliShowOutput.parse>;
type Detail = ShowOutput['intent'];

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

/** 把 ssh 的结果认成约定的形状；认不出、对不上一律抛，不返回「空」。 */
export function readOutcome<S extends typeof IntentCliListOutput | typeof IntentCliShowOutput>(
  schema: S,
  run: RemoteRun,
): ReturnType<S['parse']> {
  if (run.code === 255) {
    throw new IntentsError('ssh-failed', `ssh 连不上法国：${lastLines(run.stderr) || '没说为什么'}`);
  }
  const body = parseJson(run.stdout);
  if (run.code !== 0) {
    const failure = IntentCliFailure.safeParse(body);
    const said = failure.success
      ? `${failure.data.why}（${failure.data.reason}）`
      : lastLines(run.stderr) || lastLines(run.stdout) || '没说为什么';
    throw new IntentsError(
      'remote-failed',
      `法国上的 fleet-api intent 没跑成（退出码 ${run.code}）：${said}`,
    );
  }
  if (body === undefined) {
    throw new IntentsError(
      'bad-shape',
      `法国回来的不是 JSON，认不出（开头：${run.stdout.trim().slice(0, 80) || '空'}）`,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new IntentsError(
      'bad-shape',
      `法国回来的和约定的形状对不上，认不出（${first?.path.join('.') || '根'}：${first?.message ?? '不对'}）`,
    );
  }
  return parsed.data as ReturnType<S['parse']>;
}

// —— 打给人看 ——

const pad = (n: number) => String(n).padStart(2, '0');
/** 「10-04 14:02」，北京时间。 */
export function beijing(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 60 * 60_000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const STATUS_WORD = { new: '新（还没处理）', linked: '已开成单', dropped: '放下了' } as const;

/** 一段意图：编号、谁说的、什么时候、原话（原样）、AI 归纳（若有）、已开成哪张单。 */
export function describeDetail(d: Detail): string {
  const live = d.messages.filter((m) => m.recalledAt === undefined);
  const names = [...new Set(live.map((m) => m.senderName))].join('、') || '没人（都撤回了）';
  const range =
    beijing(d.firstMessageAt) === beijing(d.lastMessageAt)
      ? beijing(d.firstMessageAt)
      : `${beijing(d.firstMessageAt)} – ${beijing(d.lastMessageAt)}`;
  const head = [
    `意图 ${d.seq}`,
    STATUS_WORD[d.status],
    `${d.chatKind === 'p2p' ? '私聊' : '群'} ${d.chatId}`,
    `${live.length} 条原话`,
    `说话的：${names}`,
    `${range}（北京时间）`,
    ...(d.continuesSeq === undefined ? [] : [`接着意图 ${d.continuesSeq}`]),
  ].join(' · ');
  const lines = [head, '原话（原样，没改一个字）：'];
  for (const m of d.messages) {
    const tags = [
      String(m.ord),
      ...(m.recalledAt === undefined
        ? []
        : [m.recalledAfterLink ? '开单后在飞书撤回了：单子里要不要删，人定' : '已撤回，不抄']),
      ...(m.edits.length > 0
        ? [`改过 ${m.edits.length} 次`]
        : m.editedAt === undefined
          ? []
          : ['飞书里改过，旧的那版这里没有']),
      ...(m.forward === undefined ? [] : [`转发，原说话人${m.forward.senderName ?? '不知道'}`]),
      beijing(m.sentAt),
      m.senderName,
    ].join(' · ');
    lines.push(`  [${tags}] ${m.text.replace(/\n/g, '\n    ')}`);
  }
  if (d.summary) {
    lines.push(
      `AI 归纳（${d.summary.by} 写的，不是原话 · ${beijing(d.summary.at)} · 覆盖到第 ${d.summary.covers} 条）：${d.summary.text}`,
    );
  } else {
    lines.push('AI 归纳：还没有（开单时由指挥官写）');
  }
  if (d.links.length === 0) lines.push('已开成：还没开单');
  for (const l of d.links) lines.push(`已开成：${l.issue}（${l.by} · ${beijing(l.at)}）`);
  if (d.dropped) lines.push(`放下：${d.dropped.reason}（${d.dropped.by} · ${beijing(d.dropped.at)}）`);
  return lines.join('\n');
}

export interface IntentsIo extends TargetIo {
  run: RunRemote;
}

export interface IntentsResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 整条命令：不抛，退出码和输出都在返回里（读不到：stderr 写「读不到：原因」，--json 时标准输出另打一行 ok:false）。 */
export async function runIntents(argv: readonly string[], io: IntentsIo): Promise<IntentsResult> {
  const json = argv.includes('--json');
  try {
    const cmd = parseIntentsArgs(argv);
    const host = readSshTarget(io);
    const run = await io.run(host, remoteCommand(cmd));
    if (cmd.kind === 'show') {
      const r = readOutcome(IntentCliShowOutput, run);
      return { code: 0, stdout: json ? JSON.stringify(r) : describeDetail(r.intent), stderr: '' };
    }
    const r = readOutcome(IntentCliListOutput, run);
    if (json) return { code: 0, stdout: JSON.stringify(r), stderr: '' };
    const what = cmd.all ? '全部' : '还没处理的';
    const head = `读成了：${what}意图 ${r.intents.length} 条${r.more ? `（只列了前 ${LIST_LIMIT} 段，后面还有没列的）` : ''}`;
    return {
      code: 0,
      stdout: r.intents.length === 0 ? head : [head, ...r.intents.map(describeDetail)].join('\n\n'),
      stderr: '',
    };
  } catch (e) {
    if (!(e instanceof IntentsError)) {
      const why = errText(e);
      return failure(json, new IntentsError('remote-failed', `没预料到的错：${why}`));
    }
    return failure(json, e);
  }
}

function failure(json: boolean, e: IntentsError): IntentsResult {
  if (e.reason === 'usage') return { code: e.exitCode, stdout: '', stderr: e.message };
  return {
    code: e.exitCode,
    stdout: json ? JSON.stringify({ ok: false, reason: e.reason, why: e.message }) : '',
    stderr: `读不到：${e.message}`,
  };
}

/** 真的环境：process.env、家目录、真 ssh。 */
export function realIo(): IntentsIo {
  return {
    env: process.env,
    home: homedir(),
    readText: (file) => readFileSync(file, 'utf8'),
    run: sshRunner(),
  };
}
