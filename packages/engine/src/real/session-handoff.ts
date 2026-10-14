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
// - Mirasim 的会话在 Mirasim 服务里跑、引擎经 ws 读，不走这条（照旧管道、照旧发版暂停）；验收、整理这些短会话也不走。

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 收发目录的根：france.sh 建的 /var/lib/fleet-sessions（fleet:fleet 711）下面一层，引擎第一次用时自己建。 */
export const DEFAULT_SESSION_IO_ROOT = '/var/lib/fleet-sessions/io';
/** 收发目录里的放手标记：上一个引擎放手时写（内容是放手的时刻），接回时删。 */
export const DETACHED_MARK = 'detached';
/** 放手以后最多等多久有人接回；过了还带着标记的照孤儿收（scope、目录、runs 那一行）。 */
export const HANDOFF_TTL_MS = 30 * 60_000;
/** 命令行那几家：会话是我们起的进程，能走文件、能接回。Mirasim 不在里面。 */
export const DETACHABLE_HOSTS: ReadonlySet<string> = new Set(['claude-code', 'cursor-agent', 'grok']);

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
      if (!ac.signal.aborted) ac.abort(new Error(why));
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
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    const text = await readFile(join(dir, DETACHED_MARK), 'utf8').catch(() => undefined);
    const at = text === undefined ? undefined : new Date(text.trim());
    // 标记写坏了（读得出、认不出）按「刚放手」算：宁可多留到 TTL，也不把可能还要接回的会话收掉
    out.push({
      runId,
      dir,
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
