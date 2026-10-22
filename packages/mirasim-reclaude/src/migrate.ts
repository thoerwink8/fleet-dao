import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type MirasimWire, openWire } from '../../adapters/src/mirasim/wire.ts';
import { prepareBinary, runtimeSourceHash } from './build.ts';
import { takeLock } from './lock.ts';

export interface PreparedBinary {
  destination: string;
  sourceHash: string;
  repo: string;
  platform: string;
  arch: string;
}
export interface MigrationOptions {
  home: string;
  repo: string;
  platform: string;
  arch: string;
  auto?: boolean;
  rollback?: boolean;
  check?: boolean;
  wait?: boolean;
  pollMs?: number;
  maxWaitMs?: number;
  replyMs?: number;
  onWaiting?: (observation: WaitingObservation) => void;
  prepare?: (input: PreparedBinary) => Promise<string>;
}
export interface WaitingObservation {
  state: 'busy' | 'unknown';
  detail: string;
  checkedAt: string;
}
export interface MigrationResult {
  state: 'migrated' | 'current' | 'restored' | 'waiting' | 'skipped' | 'drift';
  command: string;
  recordFile: string;
  detail: string;
  /** 只读判断出的启动命令现状，见 classifyLaunch。 */
  status?: LaunchStatus;
}
/**
 * 启动命令现状。Mirasim 的启动命令随时可能被人或升级改掉，所以要分清：
 * installed＝当前就是本工具装的启动器；drift＝装过但被改回了裸 claude；
 * never＝从没装过（含只有旧封装）；restored＝主动撤回过；custom＝人自己的启动器。
 */
export type LaunchStatus = 'installed' | 'drift' | 'never' | 'restored' | 'custom';
interface Launch {
  command: string;
  args?: string;
}
interface RecordData {
  schema: 1;
  previous: Launch;
  command: string;
  sourceHash: string;
  binaryHash: string;
  updatedAt: string;
  state: string;
}
type Json = Record<string, unknown>;

/** 裸 claude：空命令、claude、claude.exe（带不带路径都一样），都不经 reclaude。 */
export function isBareClaude(command: string): boolean {
  if (!command.trim()) return true;
  return ['claude', 'claude.exe'].includes(basename(command.replaceAll('\\', '/')).toLowerCase());
}

function sameLaunch(a: Launch, b: Launch): boolean {
  const sameCommand = a.command === b.command || (isBareClaude(a.command) && isBareClaude(b.command));
  return sameCommand && (a.args ?? '') === (b.args ?? '');
}

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}
function readJson(file: string, label: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${label}读取失败或 JSON 格式错误`);
  }
  const data = object(value);
  if (!data) throw new Error(`${label}不是 JSON 对象`);
  return data;
}

export function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
}

function launchOf(data: Json): Launch {
  const launch = object(object(data.agentLaunch)?.claude);
  const command = launch?.command;
  if (command !== undefined && typeof command !== 'string') throw new Error('Mirasim 启动命令格式错误');
  if (launch?.args !== undefined && typeof launch.args !== 'string')
    throw new Error('Mirasim 启动参数格式错误');
  return {
    command: typeof command === 'string' && command.trim() ? command : 'claude',
    ...(typeof launch?.args === 'string' ? { args: launch.args } : {}),
  };
}

export function isManagedLaunch(command: string): boolean {
  const name = basename(command.replaceAll('\\', '/')).toLowerCase();
  return ['reclaude-mirasim', 'reclaude-mirasim.exe', 'mirasim-reclaude', 'mirasim-reclaude.exe'].includes(
    name,
  );
}

function compatible(command: string): boolean {
  return (
    isManagedLaunch(command) ||
    ['reclaude', 'reclaude.exe', 'claude', 'claude.exe'].includes(
      basename(command.replaceAll('\\', '/')).toLowerCase(),
    )
  );
}

function binaryHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function verifyBinary(file: string, input: PreparedBinary): void {
  let value: unknown;
  try {
    value = JSON.parse(
      execFileSync(file, ['--fleet-version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }),
    );
  } catch {
    throw new Error('新启动器版本验证失败，旧机制没有替换');
  }
  const info = object(value);
  if (info?.name !== 'fleet-mirasim-reclaude' || info.schema !== 1 || info.version !== '2.0.0')
    throw new Error('下载或编译的不是新版 Mirasim 启动器');
  const goPlatform = input.platform === 'win32' ? 'windows' : input.platform;
  const goArch = input.arch === 'x64' ? 'amd64' : input.arch;
  if (info.platform !== goPlatform || info.arch !== goArch)
    throw new Error('新启动器平台或架构不匹配，旧机制没有替换');
  if (info.sourceHash !== input.sourceHash) throw new Error('新启动器源码版本不匹配，旧机制没有替换');
}

function verifyTarget(file: string, home: string): void {
  let info: Json | undefined;
  try {
    info = object(
      JSON.parse(
        execFileSync(file, ['--fleet-doctor'], {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
          env: { ...process.env, HOME: home, USERPROFILE: home },
        }),
      ),
    );
  } catch {
    throw new Error('新启动器找不到可用的 reclaude 目标，旧接入没有替换');
  }
  if (info?.status !== 'ready') throw new Error('新启动器目标检查没有确认成功');
}

/**
 * 数在途的 Claude 回合。单个会话记录读不了、坏了或状态不认识，记进 unknown（没查成），不整个抛：
 * 调用方按「判不了是否空闲」处理（不当空闲），其余会话照数。
 */
export function runningSessions(home: string): { running: number; unknown: string[] } {
  const folder = join(home, '.mirasim', 'sessions', 'claude');
  if (!existsSync(folder)) return { running: 0, unknown: [] };
  let running = 0;
  const unknown: string[] = [];
  for (const name of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!name.isDirectory()) continue;
    let record: Json;
    try {
      record = readJson(join(folder, name.name, 'record.json'), 'Claude 会话记录');
    } catch {
      unknown.push(name.name);
      continue;
    }
    if (
      !['running', 'queued', 'completed', 'incomplete', 'failed', 'stopped', 'interrupted', 'idle'].includes(
        String(record.runState),
      )
    ) {
      unknown.push(name.name);
      continue;
    }
    if (record.runState === 'running' || record.runState === 'queued') running++;
  }
  return { running, unknown };
}

async function configOf(wire: MirasimWire, replyMs = 5_000): Promise<Json> {
  wire.send({ type: 'getConfig' });
  const end = Date.now() + replyMs;
  while (Date.now() < end) {
    const f = await wire.next(Math.max(1, end - Date.now()));
    if (f === 'closed') throw new Error('Mirasim 配置连接断开');
    if (f === 'timeout') break;
    if (f.type === 'error') throw new Error('Mirasim 配置请求失败');
    if (f.type === 'config') {
      const cfg = object(f.config);
      if (!cfg) throw new Error('Mirasim 配置帧格式错误');
      return cfg;
    }
  }
  throw new Error('Mirasim 配置回读超时');
}

async function liveLaunchOf(wire: MirasimWire, replyMs = 5_000): Promise<Launch> {
  // getConfig 只暴露功能设置，启动命令在 listClis 的 launch 字段。
  wire.send({ type: 'listClis' });
  const end = Date.now() + replyMs;
  while (Date.now() < end) {
    const frame = await wire.next(Math.max(1, end - Date.now()));
    if (frame === 'closed') throw new Error('Mirasim 启动器列表连接断开');
    if (frame === 'timeout') break;
    if (frame.type === 'error') throw new Error('Mirasim 启动器列表请求失败');
    if (frame.type !== 'clis') continue;
    if (!Array.isArray(frame.clis)) throw new Error('Mirasim 启动器列表格式错误');
    const rows = frame.clis.map(object).filter((row) => row?.id === 'claude');
    if (rows.length !== 1) throw new Error('Mirasim 启动器列表没有唯一 Claude 条目');
    const launch = object(rows[0]?.launch);
    // 人在界面清空命令时 command 可能是空串，此时 Mirasim 用 defaultBin。
    const command =
      typeof launch?.command === 'string' && launch.command.trim() ? launch.command : launch?.defaultBin;
    if (typeof command !== 'string' || !command.trim()) throw new Error('Mirasim 启动器列表缺少有效命令');
    if (launch?.args !== undefined && typeof launch.args !== 'string')
      throw new Error('Mirasim 启动器参数格式错误');
    return { command, ...(typeof launch?.args === 'string' ? { args: launch.args } : {}) };
  }
  throw new Error('Mirasim 启动器列表回读超时');
}

async function connectInstances(
  home: string,
  replyMs: number,
): Promise<{ wires: MirasimWire[]; complete: boolean }> {
  const dir = join(home, '.mirasim', 'run');
  if (!existsSync(dir)) return { wires: [], complete: false };
  const wires: MirasimWire[] = [];
  let complete = true;
  for (const name of readdirSync(dir).sort()) {
    const match = /^local-(\d+)\.token$/.exec(name);
    if (!match) continue;
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Mirasim 本地端口格式错误');
    let token: string;
    try {
      token = readFileSync(join(dir, name), 'utf8').trim();
    } catch {
      throw new Error('Mirasim 本地凭据读失败');
    }
    if (!token) throw new Error('Mirasim 本地凭据为空');
    const attempt = openWire(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    let timedOut = false;
    let opened: MirasimWire | undefined;
    try {
      const wire = await Promise.race([
        attempt,
        sleep(3_000).then(() => {
          timedOut = true;
          throw new Error('连接未就绪');
        }),
      ]);
      opened = wire;
      await configOf(wire, replyMs);
      wires.push(wire);
    } catch (error) {
      complete = false;
      opened?.close();
      if (timedOut) void attempt.then((w) => w.close()).catch(() => {});
      if (opened) {
        for (const w of wires) w.close();
        throw error;
      }
    }
  }
  return { wires, complete };
}

type Idleness = 'idle' | 'busy' | 'unknown';

/** 只补核列表也不存在的历史目录；现存会话的 snapshot 不推测成空闲。 */
async function orphanIdleness(
  wire: MirasimWire,
  ids: string[],
  replyMs: number,
): Promise<{ state: Idleness; detail: string }> {
  const unknown = (detail: string) => ({ state: 'unknown' as const, detail });
  const reqId = randomUUID();
  wire.send({ type: 'listSessions', reqId, scope: 'global' });
  let deadline = Date.now() + replyMs;
  let listed = false;
  while (Date.now() < deadline) {
    const frame = await wire.next(Math.max(1, deadline - Date.now()));
    if (typeof frame === 'string' || frame.type === 'error')
      return unknown('原生全局列表超时、断开或请求失败');
    if (frame.type !== 'sessions' || frame.reqId !== reqId) continue;
    // reqId 的 global 请求不带 limit/query/source/workdir：服务器走未截断的全局列表。
    if (frame.hasMore !== false || !Array.isArray(frame.sessions))
      return unknown('原生全局列表不完整或格式错误');
    const keys = new Set<string>();
    for (const value of frame.sessions) {
      const row = object(value);
      if (typeof row?.agent !== 'string' || typeof row.sessionKey !== 'string')
        return unknown('原生会话条目缺少来源或标识');
      if (keys.has(row.sessionKey)) return unknown('原生全局列表有重复标识');
      keys.add(row.sessionKey);
      if (row.agent !== 'claude') continue;
      if (!row.sessionKey.startsWith('claude:')) return unknown('原生 Claude 会话标识与来源不一致');
      if (
        row.runState === 'running' ||
        row.runState === 'queued' ||
        row.phase === 'streaming' ||
        row.phase === 'queued' ||
        row.awaiting === true
      )
        return { state: 'busy', detail: '原生全局列表仍有在途 Claude 回合' };
      if (
        !['completed', 'incomplete', 'failed', 'stopped', 'interrupted', 'idle'].includes(
          String(row.runState),
        )
      )
        return unknown('原生 Claude 会话状态缺失或不认识');
      // 附带的后台活动字段若存在，必须明确为空，未知形状也不当空闲。
      if (
        row.backgroundJobs !== undefined &&
        (!Array.isArray(row.backgroundJobs) || row.backgroundJobs.length)
      )
        return unknown('原生 Claude 会话的后台任务没有确认清空');
    }
    if (ids.some((id) => keys.has(`claude:${id}`)))
      return unknown('原生全局列表仍有缺失磁盘记录的会话，不能认作历史残留');
    listed = true;
    break;
  }
  if (!listed) return unknown('原生全局列表没有按请求号回读成功');
  for (const id of ids) {
    const sessionKey = `claude:${id}`;
    wire.send({ type: 'subscribe', sessionKey });
    try {
      deadline = Date.now() + replyMs;
      let confirmed = false;
      while (Date.now() < deadline) {
        const frame = await wire.next(Math.max(1, deadline - Date.now()));
        if (typeof frame === 'string' || frame.type === 'error')
          return unknown('原生活动基线超时、断开或请求失败');
        if (frame.sessionKey !== sessionKey) continue;
        if (frame.type === 'snapshot') return unknown('原生仍有会话运行态，不能认作历史残留');
        if (frame.type !== 'outbox' || frame.baseline !== true) continue;
        // noRun 来自 snapshotFor 的明确 null（内存 map 和 loom IO 均无运行态），
        // 不是把 snapshot 没回或队列为空当成没有运行态。
        if (frame.noRun !== true || !Array.isArray(frame.items) || frame.items.length)
          return unknown('原生活动基线没有明确确认 noRun 和空队列');
        confirmed = true;
        break;
      }
      if (!confirmed) return unknown('原生活动基线未回读成功');
    } finally {
      wire.send({ type: 'unsubscribe', sessionKey });
    }
  }
  return { state: 'idle', detail: '' };
}

async function idle(
  home: string,
  wires: MirasimWire[],
  o: MigrationOptions,
  complete: boolean,
): Promise<Idleness> {
  const deadline = Date.now() + (o.maxWaitMs ?? 6 * 60 * 60_000);
  let quiet = 0;
  for (;;) {
    const { running, unknown } = runningSessions(home);
    for (const w of wires) await configOf(w, o.replyMs);
    // 有会话记录没查成：判不了是否空闲，不当空闲（可能正写到一半，等着重查）。
    let state: Idleness = running > 0 ? 'busy' : unknown.length ? 'unknown' : 'idle';
    let detail = running
      ? `有在途 Claude 回合（磁盘记录 ${running} 个），等待空闲`
      : `有 ${unknown.length} 个 Claude 会话记录没查成，存在未连接的原生实例，无法确认历史残留`;
    if (!running && unknown.length && complete) {
      for (const wire of wires) {
        const native = await orphanIdleness(wire, unknown, o.replyMs ?? 5_000);
        state = native.state;
        detail = `有 ${unknown.length} 个 Claude 会话记录没查成；${native.detail}，等待重查`;
        if (state !== 'idle') break;
      }
    }
    if (state !== 'idle')
      o.onWaiting?.({
        state,
        detail,
        checkedAt: new Date().toISOString(),
      });
    quiet = state === 'idle' ? quiet + 1 : 0;
    if (quiet >= 2) return 'idle';
    if (state !== 'idle' && !o.wait) return state;
    // 原生基线无请求号；失败后由外层以新连接重查，不能在同连接认领迟到的旧基线。
    if (state === 'unknown') return state;
    // 到期还没连续两次确认空闲：照旧按没空闲算。
    if (Date.now() >= deadline) return state === 'idle' ? 'busy' : state;
    await sleep(o.pollMs ?? 1_000);
  }
}

const UNKNOWN_IDLE = '有 Claude 会话记录读不了或状态不认识（没查成），判不了是否空闲，旧接入保留，等待重查';

async function setLaunch(wires: MirasimWire[], wanted: Launch, replyMs = 5_000): Promise<void> {
  for (const wire of wires) {
    wire.send({ type: 'setAgentLaunch', agent: 'claude', command: wanted.command, args: wanted.args ?? '' });
    const end = Date.now() + replyMs;
    let matched = false;
    while (Date.now() < end) {
      const actual = await liveLaunchOf(wire, replyMs);
      if (sameLaunch(actual, wanted)) {
        matched = true;
        break;
      }
      await sleep(30);
    }
    if (!matched) throw new Error('Mirasim 启动命令回读未匹配，迁移没有确认成功');
  }
}

export async function migrate(o: MigrationOptions): Promise<MigrationResult> {
  if (o.auto && o.platform === 'linux')
    return {
      state: 'skipped',
      command: '',
      recordFile: join(o.home, '.fleet-dao', 'mirasim-reclaude', 'migration.json'),
      detail: 'Linux 的无头渠道保持由 Fleet 控制',
    };
  if (o.check) return migrateUnlocked(o);
  const release = takeLock(o.home, 'migration');
  if (!release)
    return {
      state: 'waiting',
      command: '',
      recordFile: join(o.home, '.fleet-dao', 'mirasim-reclaude', 'migration.json'),
      detail: '另一个迁移正在进行，未重复写入',
    };
  try {
    return await migrateUnlocked(o);
  } finally {
    release();
  }
}

function readRecord(recordFile: string): RecordData | undefined {
  if (!existsSync(recordFile)) return undefined;
  const data = readJson(recordFile, '迁移记录');
  if (
    data.schema !== 1 ||
    typeof data.command !== 'string' ||
    typeof data.sourceHash !== 'string' ||
    typeof data.binaryHash !== 'string' ||
    !object(data.previous) ||
    typeof object(data.previous)?.command !== 'string' ||
    !String(object(data.previous)?.command).trim() ||
    (object(data.previous)?.args !== undefined && typeof object(data.previous)?.args !== 'string') ||
    !/^[0-9a-f]{64}$/.test(data.sourceHash as string) ||
    !/^[0-9a-f]{64}$/.test(data.binaryHash as string) ||
    !['prepared', 'migrated', 'restored'].includes(String(data.state))
  )
    throw new Error('迁移记录格式错误');
  return data as unknown as RecordData;
}

/**
 * 只看启动命令和迁移记录判断现状，不连 Mirasim、不验版本。
 * drift 只认裸 claude：其他自定义命令是人有意配的，不当成被改掉。
 */
export function classifyLaunch(before: Launch, saved: RecordData | undefined): LaunchStatus {
  if (saved?.state === 'migrated' && before.command === saved.command) return 'installed';
  if (saved?.state === 'migrated' && isBareClaude(before.command)) return 'drift';
  if (saved?.state === 'restored') return 'restored';
  if (!compatible(before.command)) return 'custom';
  return 'never';
}

/** 读本机现状给对账用；没有 Mirasim 设置返回 undefined。 */
export function readLaunchStatus(home: string): { status: LaunchStatus; command: string } | undefined {
  const setting = join(home, '.mirasim', 'setting.json');
  if (!existsSync(setting)) return undefined;
  const before = launchOf(readJson(setting, 'Mirasim 设置'));
  const saved = readRecord(join(home, '.fleet-dao', 'mirasim-reclaude', 'migration.json'));
  return { status: classifyLaunch(before, saved), command: before.command };
}

/** 开会话时自动同步只发现、不装回：这一行进开会话钩子的上下文，让人和 AI 都看见。 */
export const DRIFT_NOTICE =
  'Mirasim 的 claude 启动命令被改回了裸 claude（不经 reclaude，会话全走平台额度）。要恢复：pnpm mirasim:migrate；确定不用：pnpm mirasim:migrate --rollback；排查看 docs/reclaude-in-mirasim.md「排查」一节';

async function migrateUnlocked(o: MigrationOptions): Promise<MigrationResult> {
  const root = join(o.home, '.fleet-dao', 'mirasim-reclaude');
  const recordFile = join(root, 'migration.json');
  let status: LaunchStatus | undefined;
  const result = (state: MigrationResult['state'], command: string, detail: string): MigrationResult => ({
    state,
    command,
    recordFile,
    detail,
    ...(status ? { status } : {}),
  });
  if (o.auto && o.platform === 'linux') return result('skipped', '', 'Linux 的无头渠道保持由 Fleet 控制');
  const setting = join(o.home, '.mirasim', 'setting.json');
  if (!existsSync(setting) && o.auto) return result('skipped', '', '没有 Mirasim 旧接入');
  const before = launchOf(readJson(setting, 'Mirasim 设置'));
  const saved = readRecord(recordFile);
  status = classifyLaunch(before, saved);
  // 被改回裸 claude：自动同步不改 Mirasim 设置，只把现象和修法说出来，由人决定装回还是撤回。
  if (o.auto && status === 'drift') return result('drift', before.command, DRIFT_NOTICE);
  if (o.auto && !isManagedLaunch(before.command))
    return result('skipped', before.command, '未检测到本工具管理的旧封装，不覆盖自定义启动器');
  if (!compatible(before.command)) {
    if (o.check)
      return result(
        'waiting',
        before.command,
        '当前是自定义启动命令，本工具不覆盖；要改用新版，先在 Mirasim 里换回 claude 再执行 pnpm mirasim:migrate',
      );
    throw new Error('当前启动器是自定义命令，自动迁移不会覆盖它');
  }
  const sourceHash = runtimeSourceHash(o.repo);
  if (
    o.auto &&
    saved?.state === 'restored' &&
    saved.sourceHash === sourceHash &&
    before.command === saved.previous.command &&
    (before.args ?? '') === (saved.previous.args ?? '')
  )
    return result('skipped', before.command, '当前版本已主动撤回，自动同步不会重装；新版本或显式迁移可继续');
  if (
    !o.rollback &&
    saved?.command === before.command &&
    existsSync(before.command) &&
    binaryHash(before.command) !== saved.binaryHash
  )
    throw new Error('已安装启动器有未确认的改动，文件校验失败；没有重新信任或覆盖它');
  if (
    !o.rollback &&
    saved?.state === 'migrated' &&
    saved?.command === before.command &&
    saved.sourceHash === sourceHash &&
    existsSync(before.command) &&
    binaryHash(before.command) === saved.binaryHash
  ) {
    verifyBinary(before.command, { ...o, sourceHash, destination: before.command });
    verifyTarget(before.command, o.home);
    return result('current', before.command, '已经是当前新版，未重启会话');
  }
  if (o.check) return result('waiting', before.command, checkDetail(status));
  if (o.rollback && saved && status === 'drift') {
    // 已经是裸 claude（不经 reclaude）：确定不用就只把记录改成主动撤回，命令不动，自动同步不再提示。
    atomicJson(recordFile, { ...saved, state: 'restored', updatedAt: new Date().toISOString() });
    return result(
      'restored',
      before.command,
      '已记为主动撤回：启动命令保持裸 claude（走平台额度），自动同步不再提示',
    );
  }
  if (o.rollback && (!saved || before.command !== saved.command))
    throw new Error('当前命令与迁移记录不一致，不能覆盖或撤回');
  const { wires, complete } = await connectInstances(o.home, o.replyMs ?? 5_000);
  if (!wires.length) return result('waiting', before.command, 'Mirasim 配置连接还没就绪，未改启动命令');
  try {
    const first = await idle(o.home, wires, o, complete);
    if (first !== 'idle')
      return result(
        'waiting',
        before.command,
        first === 'unknown' ? UNKNOWN_IDLE : '有在途 Claude 回合，旧接入保留，等待空闲',
      );
    const current = launchOf(readJson(setting, 'Mirasim 设置'));
    if (!sameLaunch(current, before)) throw new Error('等待期间启动配置被其他操作修改，未覆盖');
    for (const wire of wires) {
      if (!sameLaunch(await liveLaunchOf(wire, o.replyMs), before))
        throw new Error('Mirasim 实例启动配置已修改，未覆盖');
    }
    if (o.rollback && saved) {
      await setLaunch(wires, saved.previous, o.replyMs);
      const back = launchOf(readJson(setting, 'Mirasim 设置'));
      if (!sameLaunch(back, saved.previous)) throw new Error('撤回设置回读失败');
      atomicJson(recordFile, { ...saved, state: 'restored', updatedAt: new Date().toISOString() });
      return result('restored', back.command, '已恢复迁移前的启动命令；新版文件仍保留');
    }
    // 等待可能持续数小时，专用检出会同步主线：以判闲后的源码准备，准备后仍校验未变化。
    const preparedHash = runtimeSourceHash(o.repo);
    const destination = join(
      root,
      'releases',
      preparedHash,
      o.platform === 'win32' ? 'mirasim-reclaude.exe' : 'mirasim-reclaude',
    );
    const input: PreparedBinary = { ...o, sourceHash: preparedHash, destination };
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const executable = await (o.prepare ?? prepareBinary)(input);
    chmodSync(executable, 0o755);
    verifyBinary(executable, input);
    verifyTarget(executable, o.home);
    const second = await idle(o.home, wires, o, complete);
    if (second !== 'idle')
      return result(
        'waiting',
        before.command,
        second === 'unknown' ? UNKNOWN_IDLE : '准备版本期间有新回合开始，未切换',
      );
    if (runtimeSourceHash(o.repo) !== preparedHash)
      throw new Error('准备期间源码已更新，未把过期版本设为启动器');
    if (!sameLaunch(launchOf(readJson(setting, 'Mirasim 设置')), before))
      throw new Error('准备期间启动配置被其他操作修改，未覆盖');
    for (const wire of wires) {
      if (!sameLaunch(await liveLaunchOf(wire, o.replyMs), before))
        throw new Error('准备期间 Mirasim 启动配置已修改，未覆盖');
    }
    // 被改回裸 claude 后由人显式装回：迁移前仍是最初那条，撤回时回到它。
    const previous =
      saved && (before.command === saved.command || isBareClaude(before.command)) ? saved.previous : before;
    const next: RecordData = {
      schema: 1,
      previous,
      command: executable,
      sourceHash: preparedHash,
      binaryHash: binaryHash(executable),
      updatedAt: new Date().toISOString(),
      state: 'prepared',
    };
    atomicJson(recordFile, next);
    await setLaunch(
      wires,
      { command: executable, ...(before.args !== undefined ? { args: before.args } : {}) },
      o.replyMs,
    );
    const actual = launchOf(readJson(setting, 'Mirasim 设置'));
    if (actual.command !== executable) throw new Error('Mirasim 磁盘设置回读失败，迁移尚未确认');
    atomicJson(recordFile, { ...next, state: 'migrated' });
    return result('migrated', executable, '旧接入已迁移，后续回合使用新机制');
  } finally {
    for (const wire of wires) wire.close();
  }
}

function checkDetail(status: LaunchStatus): string {
  switch (status) {
    case 'drift':
      return 'Mirasim 的 claude 启动命令被改回了裸 claude（不经 reclaude，会话全走平台额度）；要恢复执行 pnpm mirasim:migrate，确定不用执行 pnpm mirasim:migrate --rollback';
    case 'restored':
      return '已主动撤回，不经新版启动器；要重新启用执行 pnpm mirasim:migrate';
    case 'installed':
      return '装的是旧版启动器，尚需更新；下次开会话会自动安排，或现在执行 pnpm mirasim:migrate';
    default:
      return '这台还没装过新版启动器（裸 claude 或旧封装）；执行 pnpm mirasim:migrate 安装';
  }
}
