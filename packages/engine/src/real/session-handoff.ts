// 动手会话脱开引擎跑、引擎重启后接回（#2238）：发版切版本、重启引擎不再停在跑的动手会话。
//
// 为什么：发版切版本要重启引擎；会话原来接在引擎进程的管道上，引擎一退就断，所以发版先给手上有会话的单发 hard 暂停、切完
// 「继续」再续会话（决定 0088）。主线绿了就发（决定 0093）以后一晚上发十来次，法国 10-12～10-15 三天 35 次「引擎叫停」里 28 次是
// 发版暂停杀的（#2181 一个钟头被杀 4 次），续上的会话还常常起不来（「迟迟没有第一帧」）。会话本来就在自己的 systemd scope 里跑
// （fleet-agent-scope），只要输入输出不走引擎的管道，引擎退了它照跑；adapters 的 detached.ts 早就支持走文件、接回。
//
// 怎么接：
// - 动手段（runSegment）跑在命令行那几家（claude-code、cursor-agent、grok）上时，会话的输入输出走收发目录
//   <根>/<runs 编号>/（根默认 /var/lib/fleet-sessions/io，france.sh 建的 fleet-sessions 是 711，会话用户进得去、列不出）。
// - 引擎收到停机信号（worker.ts 的 installGracefulShutdown）先 leave()：在跑的放手（不再读、不计时、不停会话），收发目录里写上
//   detached 标记，这一段交回 SEGMENT_DETACHED；发布排空不等它们、不停它们，release.sh 也不给它们发暂停（drain.json 里没有它们）。
// - 新引擎起来：收孤儿时（orphan-reap.ts）带 detached 标记、还没过 HANDOFF_TTL_MS 的不收（scope、临时目录、runs 那一行都留着）；
//   工作流隔一小会儿带上 attach 再调 runSegment，Spawner 清掉标记、从头重读输出接回，等它收场，结局记到原来那一行。
//   过了 HANDOFF_TTL_MS 还没人接的（单子在引擎不在时被放弃了之类）照孤儿收掉。
// - Mirasim 的动手段（#2815）也走这条，但没有进程、没有输出文件：会话在 Mirasim 服务里跑，不靠引擎的 ws 连接活着，引擎只是
//   经 ws 读。所以收发目录里存的是「交接单」mirasim.json（会话号、这一轮的轮次号、run 号），服务端一接下（accepted）就写；
//   引擎停机放手 = 只断开 ws、不发 stop（适配器的 release），照样写放手标记；新引擎带 attach 来，按交接单的会话号重新订阅，
//   订阅回的整份快照重建状态、重复的帧按序号丢掉，一直读到收场。过了 HANDOFF_TTL_MS 没人接回的，照孤儿收，这时才给服务端发 stop
//   （orphan-reap.ts 的 stopMirasim）。切号、人叫停、总时长、卡住被杀走的是叫停（signal），照旧发 stop，不放手。
// - 冷验收（#2848）一家验的会话也走这条（real/task-verify.ts）：coldVerify 交回 detached，工作流带 attach 再调同一次验收，
//   接回的结论照常贴、照常认；交接单、放手标记、收孤儿都和动手段同一套。两家都验的两个会话并行跑、不脱开，发版叫停了
//   不算没过、重验一次。整理、指挥官会话不走这条。

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StopReason } from '@fleet-dao/adapters';

/** 收发目录的根：france.sh 建的 /var/lib/fleet-sessions（fleet:fleet 711）下面一层，引擎第一次用时自己建。 */
export const DEFAULT_SESSION_IO_ROOT = '/var/lib/fleet-sessions/io';
/** 收发目录里的放手标记：上一个引擎放手时写（内容是放手的时刻），接回时删。 */
export const DETACHED_MARK = 'detached';
/** 放手以后最多等多久有人接回；过了还带着标记的照孤儿收（scope、目录、runs 那一行）。 */
export const HANDOFF_TTL_MS = 30 * 60_000;
/** 交接单的文件名（Mirasim，#2815）：和放手标记同在收发目录里。 */
export const MIRASIM_HANDLE_FILE = 'mirasim.json';
/**
 * 能脱开引擎跑、引擎重启后接回的执行方式：命令行那几家（我们起的进程，走收发目录文件）和 Mirasim（会话在服务端，
 * 收发目录里只放交接单）。
 */
export const DETACHABLE_HOSTS: ReadonlySet<string> = new Set([
  'claude-code',
  'cursor-agent',
  'grok',
  'mirasim',
]);

/** Mirasim 会话的交接单：新引擎凭它重新订阅（会话号、轮次号），orphan 收时凭它给服务端发 stop。 */
export interface MirasimHandle {
  /** runs 编号（run 号）。 */
  runId: string;
  /** 服务端的会话号（sessionKey）。 */
  sessionKey: string;
  /** 这一轮的轮次号（accepted 帧的 taskId）：接回后按它认哪一份快照是这一轮的；服务端没给就没有。 */
  taskId?: string;
  acceptedAt: string;
  /** 放手时过程记录写到了第几条（下一条的序号）：接回的记录员从这里接着编。没记就没有。 */
  transcriptNext?: number;
}

/** 写交接单（同步：服务端一接下就落盘，放手来得再快也不会差这一步）。目录还没建先建上。 */
export function writeMirasimHandle(dir: string, handle: MirasimHandle): void {
  mkdirSync(dir, { recursive: true, mode: 0o711 });
  writeFileSync(join(dir, MIRASIM_HANDLE_FILE), `${JSON.stringify(handle)}\n`, { mode: 0o600 });
}

/** 读交接单：没有文件是 undefined（不是 Mirasim 的会话，或还没被服务端接下）；有文件但认不出就抛，不当成没有。 */
export async function readMirasimHandle(dir: string): Promise<MirasimHandle | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, MIRASIM_HANDLE_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const raw: unknown = JSON.parse(text);
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  if (typeof o.runId !== 'string' || typeof o.sessionKey !== 'string' || typeof o.acceptedAt !== 'string') {
    throw new Error(
      `Mirasim 交接单认不出（缺 runId、sessionKey 或 acceptedAt）：${join(dir, MIRASIM_HANDLE_FILE)}`,
    );
  }
  return {
    runId: o.runId,
    sessionKey: o.sessionKey,
    acceptedAt: o.acceptedAt,
    ...(typeof o.taskId === 'string' && o.taskId ? { taskId: o.taskId } : {}),
    ...(typeof o.transcriptNext === 'number' && Number.isInteger(o.transcriptNext) && o.transcriptNext >= 0
      ? { transcriptNext: o.transcriptNext }
      : {}),
  };
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

export interface SessionHandoff {
  /** 收发目录的根。 */
  readonly root: string;
  /** 引擎要走了（收到停机信号）：响了，脱开跑的会话放手。 */
  readonly signal: AbortSignal;
  /** 这一段脱开跑了（Spawner 交给驱动之前调）；返回收场时调的撤销。 */
  enter(runId: string): () => void;
  /** 引擎要走了：放手手上脱开跑的会话，返回放手了哪几个（runs 编号）。调几次都行。 */
  leave(why: string): string[];
}

export function sessionHandoff(root: string = DEFAULT_SESSION_IO_ROOT): SessionHandoff {
  const ac = new AbortController();
  const live = new Set<string>();
  return {
    root,
    signal: ac.signal,
    enter(runId) {
      live.add(runId);
      return () => live.delete(runId);
    },
    leave(why) {
      const ids = [...live];
      if (!ac.signal.aborted) ac.abort(new StopReason('release-pause', why));
      return ids;
    },
  };
}

/** 这一次会话的收发目录。编号认不出（带路径分隔、..）就抛：不拿它拼路径。 */
export function ioDirOf(root: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`会话编号放不进收发目录名：${runId}`);
  return join(root, runId);
}

/** 根不在就建（0711：会话用户进得去自己那一格、列不出别人的）。 */
export async function ensureIoRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o711 });
}

/** 写放手标记。目录还没建好（驱动正要起会话的那一下就放手了）先建上：驱动建收发目录不会删掉它。 */
export async function markDetached(dir: string, at: Date): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o711 });
  await writeFile(join(dir, DETACHED_MARK), `${at.toISOString()}\n`, { mode: 0o600 });
}

/** 接回时删标记：删了就不再算「等人接」，收孤儿不会碰它。没有标记不算错。 */
export async function clearDetached(dir: string): Promise<void> {
  await rm(join(dir, DETACHED_MARK), { force: true });
}

/** 收发目录的一格。 */
export interface IoEntry {
  runId: string;
  dir: string;
  /** 放手的时刻（标记里写的）；没有标记是 undefined。 */
  detachedAt?: Date;
  /** Mirasim 会话的交接单（#2815）；不是 Mirasim 的、或还没写、读不出，都是 undefined。 */
  mirasim?: MirasimHandle;
}

/** 列收发目录：根不在当成一格都没有；读不了照抛（调用方报，不当成没有）。 */
export async function listIo(root: string): Promise<IoEntry[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: IoEntry[] = [];
  for (const runId of names) {
    if (!RUN_ID.test(runId)) continue;
    const dir = join(root, runId);
    const info = await stat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info?.isDirectory()) continue;
    const text = await readFile(join(dir, DETACHED_MARK), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const at = text === undefined ? undefined : new Date(text.trim());
    // 缺文件可以是 CLI 会话；有文件却读不懂时不能把仍在用的目录当成孤儿删。
    const mirasim = await readMirasimHandle(dir);
    // 标记写坏了（读得出、认不出）按「刚放手」算：宁可多留到 TTL，也不把可能还要接回的会话收掉
    out.push({
      runId,
      dir,
      ...(mirasim ? { mirasim } : {}),
      ...(text === undefined
        ? {}
        : { detachedAt: at && !Number.isNaN(at.getTime()) ? at : new Date(info.mtimeMs) }),
    });
  }
  return out;
}

/** 放手了、还没过 TTL 的：等人接回，收孤儿不碰。 */
export function awaitingAttach(
  entries: readonly IoEntry[],
  now: Date,
  ttlMs: number = HANDOFF_TTL_MS,
): Set<string> {
  return new Set(
    entries
      .filter((e) => e.detachedAt !== undefined && now.getTime() - e.detachedAt.getTime() < ttlMs)
      .map((e) => e.runId),
  );
}

export async function removeIo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
