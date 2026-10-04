// 派活时按内存做准入（#219）：派一个会话出去之前，先看父节点 fleet-agents.slice 此刻的用量还放不放得下一个新会话。
//
// #164 原定「按内存算同时跑测试的会话上限」已经被 #423 顶替——「总量不超」的安全垫挪到了父节点 fleet-agents.slice 的
// MemoryHigh/MemoryMax 那一道总闸（deploy/france/fleet-agents.slice），不再按「总内存 ÷ 同时几个会话」掐每个会话。
// 剩下的一格是**派活时按内存做准入**：引擎选路目前只看账号池的并发空位和额度，不看内存——法国的机器内存紧（11.7G），
// 几张单同时开工时可能整张资源池已经顶到 MemoryHigh 附近了，这时候再把一个新会话派出去，多半就是它（或它和同道的会话
// 里的某一个）被内核先压回收再硬杀。在选路之前先看一次父节点的 memory.current，放不下就等，比在 cgroup 里被杀要可控。
//
// 读的是 /sys/fs/cgroup/fleet.slice/fleet-agents.slice/memory.current（cgroup v2，当前用量，字节；分层累计，和
// MemoryMax 那把总闸同一层）：
// - 文件**不存在**：不是法国机器（本机开发没有 cgroup、worker 仓里单是别的机器在跑），跳过准入、照派——不为一道没有的闸
//   把活全挡住，那条闸本来也不在这台机器上。
// - 文件存在、**读不成或数认不出**：明确的失败（readError），按「没查成」处理——不派、也不悄悄照派。这不是「没启用准入」，
//   是「闸在，但我这会儿读不到它」；这种情况下派出去等于闭眼过马路，需求文档（specs/219-测试会话并发上限/需求.md
//   「算不出上限要明确报错、不派」）就是这么定的。
// - 数读出来了：高水位（MemoryHigh）- current 的余量还放不放得下一份「新会话预留」（SESSION_RESERVE_MB）。
//   放不下 → wait，等别家收场或内核把它压下去，再选一次。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errMessage } from '@fleet-dao/shared/util';
import { SLICE_MEMORY_HIGH_MB } from '../limits.ts';

export const CGROUP_ROOT = '/sys/fs/cgroup';
/** 会话资源池在 cgroup 树里的位置（和 kill-evidence.ts 的 AGENT_SLICE_PATH 一致；systemd 的层级用「-」连）。 */
export const AGENT_SLICE_PATH = 'fleet.slice/fleet-agents.slice';

/**
 * 给一个新会话预留多少内存（MiB）。不按 SESSION_MEMORY_MAX_MB 全额（6 GiB）——那是单会话自己的硬顶、干活时到那量级
 * 才被内核拦，**开工时**都要这么多钱才让派会把门槛抬得太死（父节点现在的高水位才 10152M，一次只容得下一个）。
 * 按实测一个会话干活时**还没**碰撞自家高水位那段（tsc + 测试 + 代理，2 个 GiB 上下；SLICE_MEMORY_MAX_MB 的注释里有原始数据），
 * 留 2 GiB 余量才放新会话进来：父节点 far from High 时照常派，已经在 High 附近了就缓一缓，别在悬崖边上再添一个。
 */
export const SESSION_RESERVE_MB = 2048;

export type MemoryVerdict =
  /** 放不下一个新会话：等。detail 里写明在等什么、什么时候再看（不知道就写「按轮询间隔」）。 */
  | { kind: 'wait'; detail: string; currentMb: number; highMb: number }
  /** 读出来的数还放得下：让派。 */
  | { kind: 'ok'; currentMb: number; highMb: number }
  /** 父节点的读数没查成（文件在、读不出来；内容认不出）：明确的失败。 */
  | { kind: 'readError'; detail: string }
  /** 不在法国机器上（没有 cgroup，或父节点那一层没挂）：跳过准入。 */
  | { kind: 'skip' };

export interface MemoryAdmissionDeps {
  readText(path: string): Promise<string>;
  cgroupRoot: string;
  slicePath: string;
  /** 父节点 MemoryHigh（拿到这个数才算「安全」）：默认 SLICE_MEMORY_HIGH_MB，测试可换。 */
  sliceHighMb: number;
  /** 给一个新会话预留的内存（MiB）：默认 SESSION_RESERVE_MB，测试可换。 */
  reservePerSessionMb: number;
}

/** memory.current 那一行：纯数字、单位是字节。认不出抛（调用方记「没查成」）。 */
export function parseMemoryCurrent(text: string): number {
  const trimmed = text.trim();
  if (!/^[1-9]\d*$|^0$/.test(trimmed)) {
    throw new Error(`memory.current 的内容认不出（前 80 字节）：${JSON.stringify(trimmed.slice(0, 80))}`);
  }
  return Number(trimmed);
}

/** 看下父节点此刻放不放得下一个新会话。不抛：读不成的归为 readError、不存在归为 skip，由调用方决定。 */
export async function admitSessionMemory(deps: MemoryAdmissionDeps): Promise<MemoryVerdict> {
  const path = join(deps.cgroupRoot, deps.slicePath, 'memory.current');
  let bytes: number;
  try {
    bytes = parseMemoryCurrent(await deps.readText(path));
  } catch (err) {
    const msg = errMessage(err);
    if (isNotFound(err)) return { kind: 'skip' };
    return { kind: 'readError', detail: `${path} 没读成（${msg}）` };
  }
  const currentMb = bytes / (1024 * 1024);
  // 余量 = 高水位 - 当前用量；能放下一份「新会话预留」才派（不是看顶到 max 才拦：到了 max 内核已经在杀了）。
  const freeMb = deps.sliceHighMb - currentMb;
  if (freeMb < deps.reservePerSessionMb) {
    return {
      kind: 'wait',
      detail:
        `会话资源池的内存余量放不下一个新会话：父节点 fleet-agents.slice 现在用了 ${Math.round(currentMb)}M，` +
        `高水位 ${deps.sliceHighMb}M、还差 ${Math.round(deps.reservePerSessionMb - freeMb)}M 才够一份新会话的预留 ` +
        `${deps.reservePerSessionMb}M。等别家收场、内核把它压下去，再选`,
      currentMb: Math.round(currentMb),
      highMb: deps.sliceHighMb,
    };
  }
  return { kind: 'ok', currentMb: Math.round(currentMb), highMb: deps.sliceHighMb };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** 生产用的读法：真文件、父节点在法国机器上的位置。 */
export function realMemoryAdmission(overrides: Partial<MemoryAdmissionDeps> = {}): MemoryAdmissionDeps {
  return {
    readText: (path) => readFile(path, 'utf8'),
    cgroupRoot: CGROUP_ROOT,
    slicePath: AGENT_SLICE_PATH,
    sliceHighMb: SLICE_MEMORY_HIGH_MB,
    reservePerSessionMb: SESSION_RESERVE_MB,
    ...overrides,
  };
}
