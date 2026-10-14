// 法国页「发版预检」（POST /api/france/preflight）：在后端进程里读七项事实，一项一行。
// 不起子进程、不读 home。法国后端 systemd 的 ProtectHome=yes，起 pnpm 会去开 ~/.config/pnpm/config.yaml，EACCES，预检永远红。
// 改这里之前必须知道：
// - 退出码只有 0（能发）和 2（不能发）。通过、留意算能发；卡住、读不到算不能发。读不到写原因，不拿 0 或「通过」顶。
// - 七项：主线头和 CI、法国在用提交、落后几个、别的发布是否在走、发版接活单元、引擎总开关、法国在跑的会话数。
// - 「别的发布」只读 /srv/fleet-dao-releases/.train 和发布请求文件，不走 readStateFiles（那条会退回 ~/.fleet-dao）。
// - 在跑的会话数用引擎写的 drain.json，进程号要在 /proc 里对上 packages/engine/src/main.ts。
//   对不上、文件读不到，写读不到，不当成 0。/proc 里没有这份 argv，才是引擎没在跑、0 个。
// - 总开关关着、还有会话在跑、上一趟卡住或没成：留意，不因此不能发。真发版的接活脚本也是这样：
//   关着就跳过暂停，会话等到收尾那一步，卡住或没成的一趟不挡下一次点发布。
// - CI 不绿、没有要发的、已有发版在走或请求还没被接、接活单元没装：卡住。

import { readdir, readFile } from 'node:fs/promises';
// 读的是法国机器上的路径（/srv、/var/lib），本机 Windows 上跑测试也得拼成正斜杠
import { join } from 'node:path/posix';
import {
  describeEngineMaster,
  type EngineMasterState,
  type FrancePreflightResponse,
  FrancePreflightResponseSchema,
  type ReleaseCard,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { readEngineMaster } from './engine-switch.ts';
import { parseTrainState, TRAIN_DIR } from './france-release.ts';
import { reply } from './http.ts';
import { readPreflightDistance } from './release-card.ts';
import { RELEASE_REQUEST_DIR, REQUEST_NAME } from './release-request.ts';
import type { CockpitEnv } from './session.ts';

/** 页面上这一行的名字：没有壳命令，就是进程里读完的事实。 */
export const PREFLIGHT_LABEL = '进程内读事实';
export const PREFLIGHT_NOT_WIRED = '这台后端没接上发版预检（开发、内存版）；到法国那台的驾驶舱开才有这颗按钮';

/** 引擎写给发布脚本的排空状态（packages/engine 的 drain.json）。 */
export const DRAIN_STATUS_FILE = '/var/lib/fleet-dao/engine/drain.json';
/** 引擎进程 argv 里的这一段：/proc 对得上才信 drain.json 是这一次写的。 */
export const ENGINE_ARGV_MARK = 'packages/engine/src/main.ts';

export type PreflightRead<T> = { ok: true; value: T } | { ok: false; why: string };

export interface MainlineFact {
  short: string;
  title: string;
  ci: 'green' | 'red' | 'pending';
  ciDetail: string;
}

export interface DeployedFact {
  short: string;
  title: string | null;
}

export type GapFact = { kind: 'same' } | { kind: 'ahead'; count: number };

export type OtherFact =
  | { kind: 'clear'; detail: string }
  | { kind: 'busy'; detail: string }
  | { kind: 'note'; detail: string };

export type ReceiverFact = { installed: true } | { installed: false; why: string };

export interface MasterFact {
  on: boolean;
  detail: string;
}

export interface SessionsFact {
  count: number;
  /** 引擎进程不在：没有会话要等。和「数出来是 0」分开写，页面能看出是哪一种。 */
  engineDown: boolean;
}

export interface PreflightFacts {
  mainline: PreflightRead<MainlineFact>;
  deployed: PreflightRead<DeployedFact>;
  gap: PreflightRead<GapFact>;
  other: PreflightRead<OtherFact>;
  receiver: PreflightRead<ReceiverFact>;
  master: PreflightRead<MasterFact>;
  sessions: PreflightRead<SessionsFact>;
}

export interface PreflightReaders {
  mainline(signal?: AbortSignal): Promise<MainlineFact>;
  deployed(signal?: AbortSignal): Promise<DeployedFact>;
  gap(signal?: AbortSignal): Promise<GapFact>;
  other(signal?: AbortSignal): Promise<OtherFact>;
  receiver(signal?: AbortSignal): Promise<ReceiverFact>;
  master(signal?: AbortSignal): Promise<MasterFact>;
  sessions(signal?: AbortSignal): Promise<SessionsFact>;
}

export const PREFLIGHT_FACT_NAMES = [
  '主线头和 CI',
  '法国在用提交',
  '落后几个',
  '别的发布是否在走',
  '发版接活单元',
  '引擎总开关',
  '法国在跑的会话数',
] as const;

type Level = '通过' | '卡住' | '留意' | '读不到';

function put(lines: string[], block: { value: boolean }, name: string, level: Level, detail: string): void {
  lines.push(`${name}：${level} ${detail}`);
  if (level === '卡住' || level === '读不到') block.value = true;
}

function whyOf(why: string): string {
  const text = why.trim();
  return text === '' ? '没写原因' : text;
}

/** 七项已经读完（或读失败）之后，排成一项一行，并给出能发 / 不能发。 */
export function renderPreflight(facts: PreflightFacts): { code: 0 | 2; stdout: string } {
  const lines: string[] = [];
  const block = { value: false };
  const mainline = facts.mainline;
  if (!mainline.ok) put(lines, block, '主线头和 CI', '读不到', whyOf(mainline.why));
  else if (mainline.value.ci === 'green') {
    put(
      lines,
      block,
      '主线头和 CI',
      '通过',
      `提交 ${mainline.value.short}「${mainline.value.title}」，CI 绿`,
    );
  } else if (mainline.value.ci === 'red') {
    put(
      lines,
      block,
      '主线头和 CI',
      '卡住',
      `提交 ${mainline.value.short}「${mainline.value.title}」，CI 红：${mainline.value.ciDetail}`,
    );
  } else {
    put(
      lines,
      block,
      '主线头和 CI',
      '卡住',
      `提交 ${mainline.value.short}「${mainline.value.title}」，CI 还在跑：${mainline.value.ciDetail}`,
    );
  }

  const deployed = facts.deployed;
  if (!deployed.ok) put(lines, block, '法国在用提交', '读不到', whyOf(deployed.why));
  else {
    const title = deployed.value.title ? `「${deployed.value.title}」` : '';
    put(lines, block, '法国在用提交', '通过', `提交 ${deployed.value.short}${title}`);
  }

  const gap = facts.gap;
  if (!gap.ok) put(lines, block, '落后几个', '读不到', whyOf(gap.why));
  else if (gap.value.kind === 'same') put(lines, block, '落后几个', '卡住', '法国已经是最新，没有要发的');
  else put(lines, block, '落后几个', '通过', `落后 ${gap.value.count} 个提交`);

  const other = facts.other;
  if (!other.ok) put(lines, block, '别的发布是否在走', '读不到', whyOf(other.why));
  else if (other.value.kind === 'busy') put(lines, block, '别的发布是否在走', '卡住', other.value.detail);
  else if (other.value.kind === 'note') put(lines, block, '别的发布是否在走', '留意', other.value.detail);
  else put(lines, block, '别的发布是否在走', '通过', other.value.detail);

  const receiver = facts.receiver;
  if (!receiver.ok) put(lines, block, '发版接活单元', '读不到', whyOf(receiver.why));
  else if (!receiver.value.installed) put(lines, block, '发版接活单元', '卡住', receiver.value.why);
  else put(lines, block, '发版接活单元', '通过', '装了');

  const master = facts.master;
  if (!master.ok) put(lines, block, '引擎总开关', '读不到', whyOf(master.why));
  else if (master.value.on) put(lines, block, '引擎总开关', '通过', master.value.detail);
  else put(lines, block, '引擎总开关', '留意', `${master.value.detail}。发完保持关`);

  const sessions = facts.sessions;
  if (!sessions.ok) put(lines, block, '法国在跑的会话数', '读不到', whyOf(sessions.why));
  else if (sessions.value.engineDown) put(lines, block, '法国在跑的会话数', '通过', '0 个（引擎没在跑）');
  else if (sessions.value.count === 0) put(lines, block, '法国在跑的会话数', '通过', '0 个');
  else {
    put(lines, block, '法国在跑的会话数', '留意', `${sessions.value.count} 个（发版会等它们做完这一步）`);
  }

  return { code: block.value ? 2 : 0, stdout: lines.join('\n') };
}

/** 七项各读各的：一项抛错只让那一行读不到，不把整次预检变成没接上。 */
export async function readPreflightFacts(
  readers: PreflightReaders,
  signal?: AbortSignal,
): Promise<PreflightFacts> {
  const one = async <T>(read: (signal?: AbortSignal) => Promise<T>): Promise<PreflightRead<T>> => {
    try {
      return { ok: true, value: await read(signal) };
    } catch (err) {
      return { ok: false, why: whyOf(errMessage(err)) };
    }
  };
  const [mainline, deployed, gap, other, receiver, master, sessions] = await Promise.all([
    one(readers.mainline),
    one(readers.deployed),
    one(readers.gap),
    one(readers.other),
    one(readers.receiver),
    one(readers.master),
    one(readers.sessions),
  ]);
  return { mainline, deployed, gap, other, receiver, master, sessions };
}

export async function runFrancePreflight(
  readers: PreflightReaders | undefined,
  now: () => Date,
  signal?: AbortSignal,
): Promise<FrancePreflightResponse> {
  const asOf = now().toISOString();
  if (!readers) return { state: 'unreadable', why: PREFLIGHT_NOT_WIRED, asOf };
  const started = now().getTime();
  const rendered = renderPreflight(await readPreflightFacts(readers, signal));
  return {
    state: 'done',
    command: PREFLIGHT_LABEL,
    code: rendered.code,
    signal: null,
    stdout: rendered.stdout,
    stderr: '',
    durationMs: Math.max(0, now().getTime() - started),
    timedOut: false,
    truncated: false,
    asOf,
  };
}

async function readOptional(
  path: string,
  readText: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await readText(path);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

export async function readTrainDir(
  dir: string = TRAIN_DIR,
  readText: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<{ stateJson: string | null; marker: boolean }> {
  const stateJson = await readOptional(join(dir, 'release-train.json'), readText);
  const marker = (await readOptional(join(dir, 'release-train.paused'), readText)) !== null;
  return { stateJson, marker };
}

export async function readPending(
  dir: string = RELEASE_REQUEST_DIR,
  readText: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<boolean> {
  return (await readOptional(join(dir, REQUEST_NAME), readText)) !== null;
}

/** 进度记录 + 还没被接走的请求 → 通过 / 卡住 / 留意。认不出的记录抛错，调用方写成读不到。 */
export function interpretOther(
  train: { stateJson: string | null; marker: boolean },
  pending: boolean,
): OtherFact {
  if (pending) return { kind: 'busy', detail: '上一份发布请求还没被法国接走' };
  if (train.stateJson === null) {
    if (train.marker) return { kind: 'note', detail: '暂停标记还在，这一趟的记录不在' };
    return { kind: 'clear', detail: '没有别的发布在走' };
  }
  const parsed = parseTrainState(train.stateJson);
  if (!parsed.ok) throw new Error(parsed.why);
  if (parsed.status === 'running') {
    return { kind: 'busy', detail: `已有发版在走（${parsed.phase}，${parsed.target}）` };
  }
  if (parsed.status === 'blocked' || parsed.status === 'failed') {
    const word = parsed.status === 'blocked' ? '卡住' : '没成';
    const why = parsed.why ? `：${parsed.why}` : '';
    return {
      kind: 'note',
      detail: `上一趟${word}，还没了结（${parsed.phase}，${parsed.target}）${why}。再点发布会另开一趟`,
    };
  }
  if (train.marker) return { kind: 'note', detail: '上一趟已经结束，暂停标记还在' };
  return { kind: 'clear', detail: '没有别的发布在走' };
}

/** /proc 里 argv 带引擎入口的进程号。读不了 /proc 抛错；某一个进程刚退或无权看，跳过那个。 */
export async function listEnginePids(
  listNames: () => Promise<string[]> = () => readdir('/proc', 'utf8'),
  readCmd: (pid: string) => Promise<string> = (pid) => readFile(`/proc/${pid}/cmdline`, 'utf8'),
): Promise<number[]> {
  let names: string[];
  try {
    names = await listNames();
  } catch (err) {
    throw new Error(`读 /proc 没成：${errMessage(err)}`);
  }
  const pids: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let cmd = '';
    try {
      cmd = await readCmd(name);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM') continue;
      throw new Error(`读 /proc/${name}/cmdline 没成：${errMessage(err)}`);
    }
    if (cmd.includes(ENGINE_ARGV_MARK)) pids.push(Number(name));
  }
  return pids;
}

/** drain.json 对得上在跑的引擎才数会话。对不上写原因，调用方不当成 0。 */
export function sessionCountFromDrain(
  text: string,
  enginePids: readonly number[],
): { ok: true; count: number } | { ok: false; why: string } {
  let parsed: { schema?: unknown; pid?: unknown; sessions?: unknown };
  try {
    parsed = JSON.parse(text) as { schema?: unknown; pid?: unknown; sessions?: unknown };
  } catch (err) {
    return { ok: false, why: `drain.json 认不出：${errMessage(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.schema !== 2) {
    return { ok: false, why: `drain.json 的 schema 不是 2（${JSON.stringify(parsed?.schema)}）` };
  }
  const pid = typeof parsed.pid === 'number' ? parsed.pid : Number(parsed.pid);
  if (!enginePids.includes(pid)) {
    return {
      ok: false,
      why: `drain.json 是进程 ${String(parsed.pid)} 留下的，在跑的引擎是 ${enginePids.join('、')}`,
    };
  }
  if (!Array.isArray(parsed.sessions)) return { ok: false, why: 'drain.json 里没有 sessions 列表' };
  return { ok: true, count: parsed.sessions.length };
}

export async function readSessionFact(io: {
  enginePids(): Promise<number[]>;
  drainText(): Promise<string | null>;
}): Promise<SessionsFact> {
  const pids = await io.enginePids();
  if (pids.length === 0) return { count: 0, engineDown: true };
  const text = await io.drainText();
  if (text === null) throw new Error('引擎在跑，drain.json 不在，在跑几个会话读不到');
  const parsed = sessionCountFromDrain(text, pids);
  if (!parsed.ok) throw new Error(parsed.why);
  return { count: parsed.count, engineDown: false };
}

type Distance = Pick<ReleaseCard, 'mainline' | 'deployed' | 'gap'>;

function mainlineFrom(row: Distance['mainline']): MainlineFact {
  if (row.state !== 'ok') throw new Error(row.why);
  if (row.ci.state === 'unreadable') {
    throw new Error(`提交 ${row.commit.short} 读到了，CI 读不到：${row.ci.why}`);
  }
  return {
    short: row.commit.short,
    title: row.commit.title,
    ci: row.ci.state,
    ciDetail: row.ci.state === 'green' ? '' : row.ci.detail,
  };
}

function deployedFrom(row: Distance['deployed']): DeployedFact {
  if (row.state !== 'ok') throw new Error(row.why);
  return { short: row.short, title: row.title };
}

function gapFrom(row: Distance['gap']): GapFact {
  if (row.state === 'unreadable') throw new Error(row.why);
  if (row.state === 'same') return { kind: 'same' };
  return { kind: 'ahead', count: row.count };
}

export interface LivePreflightInput {
  distance(signal?: AbortSignal): Promise<Distance>;
  master(): Promise<EngineMasterState>;
  receiver(): Promise<{ ok: true } | { ok: false; why: string }>;
  readText?: (path: string) => Promise<string>;
  listProc?: () => Promise<string[]>;
  trainDir?: string;
  requestDir?: string;
  drainFile?: string;
}

/** 正式环境的七项读法。同一次预检里主线、在用提交、落后几个共用一次发版卡读取。 */
export function liveFrancePreflightReaders(input: LivePreflightInput): PreflightReaders {
  const readText = input.readText ?? ((path: string) => readFile(path, 'utf8'));
  const trainDir = input.trainDir ?? TRAIN_DIR;
  const requestDir = input.requestDir ?? RELEASE_REQUEST_DIR;
  const drainFile = input.drainFile ?? DRAIN_STATUS_FILE;
  let distanceP: Promise<Distance> | undefined;
  const distance = (signal?: AbortSignal) => (distanceP ??= input.distance(signal));
  return {
    async mainline(signal) {
      return mainlineFrom((await distance(signal)).mainline);
    },
    async deployed(signal) {
      return deployedFrom((await distance(signal)).deployed);
    },
    async gap(signal) {
      return gapFrom((await distance(signal)).gap);
    },
    async other() {
      const [train, pending] = await Promise.all([
        readTrainDir(trainDir, readText),
        readPending(requestDir, readText),
      ]);
      return interpretOther(train, pending);
    },
    async receiver() {
      const found = await input.receiver();
      if (found.ok) return { installed: true };
      return { installed: false, why: found.why };
    },
    async master() {
      const state = await input.master();
      return { on: state.on, detail: describeEngineMaster(state) };
    },
    async sessions() {
      return readSessionFact({
        enginePids: () =>
          input.listProc
            ? listEnginePids(input.listProc, (pid) => readText(`/proc/${pid}/cmdline`))
            : listEnginePids(),
        drainText: () => readOptional(drainFile, readText),
      });
    },
  };
}

/** main.ts 正式环境装上的那一版：发版卡、总开关、接活单元都是后端里现成的读法。 */
export function productionPreflightReaders(deps: Deps): PreflightReaders | undefined {
  const card = deps.releaseCard;
  const request = deps.releaseRequest;
  if (!card || !request) return undefined;
  return liveFrancePreflightReaders({
    distance: (signal) =>
      readPreflightDistance({
        port: card,
        store: deps.store,
        now: deps.now,
        ...(signal ? { signal } : {}),
      }),
    master: () => readEngineMaster(deps.store),
    receiver: () => request.receiverInstalled(),
  });
}

export function registerFrancePreflightRoute(app: Hono<CockpitEnv>, deps: Deps): void {
  app.post('/france/preflight', async (c) => {
    const signal = c.req.raw.signal;
    const readers = deps.francePreflight ? deps.francePreflight(signal) : undefined;
    return reply(c, FrancePreflightResponseSchema, await runFrancePreflight(readers, deps.now, signal));
  });
}
