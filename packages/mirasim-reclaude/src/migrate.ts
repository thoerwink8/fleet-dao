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
  prepare?: (input: PreparedBinary) => Promise<string>;
}
export interface MigrationResult {
  state: 'migrated' | 'current' | 'restored' | 'waiting' | 'skipped';
  command: string;
  recordFile: string;
  detail: string;
}
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

function sameLaunch(a: Launch, b: Launch): boolean {
  return a.command === b.command && (a.args ?? '') === (b.args ?? '');
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
    command: typeof command === 'string' ? command : 'claude',
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

function runningSessions(home: string): number {
  const folder = join(home, '.mirasim', 'sessions', 'claude');
  if (!existsSync(folder)) return 0;
  let count = 0;
  for (const name of readdirSync(folder, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const record = readJson(join(folder, name.name, 'record.json'), 'Claude 会话记录');
    if (
      !['running', 'queued', 'completed', 'incomplete', 'failed', 'stopped', 'interrupted', 'idle'].includes(
        String(record.runState),
      )
    )
      throw new Error('Claude 会话状态不认识，不能确认空闲');
    if (record.runState === 'running' || record.runState === 'queued') count++;
  }
  return count;
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
    const command = launch?.command ?? launch?.defaultBin;
    if (typeof command !== 'string' || !command.trim()) throw new Error('Mirasim 启动器列表缺少有效命令');
    if (launch?.args !== undefined && typeof launch.args !== 'string')
      throw new Error('Mirasim 启动器参数格式错误');
    return { command, ...(typeof launch?.args === 'string' ? { args: launch.args } : {}) };
  }
  throw new Error('Mirasim 启动器列表回读超时');
}

async function connectInstances(home: string, replyMs: number): Promise<MirasimWire[]> {
  const dir = join(home, '.mirasim', 'run');
  if (!existsSync(dir)) return [];
  const wires: MirasimWire[] = [];
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
      opened?.close();
      if (timedOut) void attempt.then((w) => w.close()).catch(() => {});
      if (opened) {
        for (const w of wires) w.close();
        throw error;
      }
    }
  }
  return wires;
}

async function idle(home: string, wires: MirasimWire[], o: MigrationOptions): Promise<boolean> {
  const deadline = Date.now() + (o.maxWaitMs ?? 6 * 60 * 60_000);
  let quiet = 0;
  for (;;) {
    const running = runningSessions(home);
    for (const w of wires) await configOf(w, o.replyMs);
    quiet = running === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return true;
    if (running > 0 && !o.wait) return false;
    if (Date.now() >= deadline) return false;
    await sleep(o.pollMs ?? 1_000);
  }
}

async function setLaunch(wires: MirasimWire[], wanted: Launch, replyMs = 5_000): Promise<void> {
  for (const wire of wires) {
    wire.send({ type: 'setAgentLaunch', agent: 'claude', command: wanted.command, args: wanted.args ?? '' });
    const end = Date.now() + replyMs;
    let matched = false;
    while (Date.now() < end) {
      const actual = await liveLaunchOf(wire, replyMs);
      if (actual.command === wanted.command && (actual.args ?? '') === (wanted.args ?? '')) {
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

async function migrateUnlocked(o: MigrationOptions): Promise<MigrationResult> {
  const root = join(o.home, '.fleet-dao', 'mirasim-reclaude');
  const recordFile = join(root, 'migration.json');
  const result = (state: MigrationResult['state'], command: string, detail: string): MigrationResult => ({
    state,
    command,
    recordFile,
    detail,
  });
  if (o.auto && o.platform === 'linux') return result('skipped', '', 'Linux 的无头渠道保持由 Fleet 控制');
  const setting = join(o.home, '.mirasim', 'setting.json');
  if (!existsSync(setting) && o.auto) return result('skipped', '', '没有 Mirasim 旧接入');
  const before = launchOf(readJson(setting, 'Mirasim 设置'));
  if (o.auto && !isManagedLaunch(before.command))
    return result('skipped', before.command, '未检测到本工具管理的旧封装，不覆盖自定义启动器');
  if (!compatible(before.command)) throw new Error('当前启动器是自定义命令，自动迁移不会覆盖它');
  const sourceHash = runtimeSourceHash(o.repo);
  const destination = join(
    root,
    'releases',
    sourceHash,
    o.platform === 'win32' ? 'mirasim-reclaude.exe' : 'mirasim-reclaude',
  );
  const input: PreparedBinary = { ...o, sourceHash, destination };
  let saved: RecordData | undefined;
  if (existsSync(recordFile)) {
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
    saved = data as unknown as RecordData;
  }
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
    verifyBinary(before.command, input);
    verifyTarget(before.command, o.home);
    return result('current', before.command, '已经是当前新版，未重启会话');
  }
  if (o.check) return result('waiting', before.command, '旧接入尚需迁移');
  if (o.rollback && (!saved || before.command !== saved.command))
    throw new Error('当前命令与迁移记录不一致，不能覆盖或撤回');
  const wires = await connectInstances(o.home, o.replyMs ?? 5_000);
  if (!wires.length) return result('waiting', before.command, 'Mirasim 配置连接还没就绪，未改启动命令');
  try {
    if (!(await idle(o.home, wires, o)))
      return result('waiting', before.command, '有在途 Claude 回合，旧接入保留，等待空闲');
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
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const executable = await (o.prepare ?? prepareBinary)(input);
    chmodSync(executable, 0o755);
    verifyBinary(executable, input);
    verifyTarget(executable, o.home);
    if (!(await idle(o.home, wires, o)))
      return result('waiting', before.command, '准备版本期间有新回合开始，未切换');
    if (runtimeSourceHash(o.repo) !== sourceHash)
      throw new Error('准备期间源码已更新，未把过期版本设为启动器');
    if (!sameLaunch(launchOf(readJson(setting, 'Mirasim 设置')), before))
      throw new Error('准备期间启动配置被其他操作修改，未覆盖');
    for (const wire of wires) {
      if (!sameLaunch(await liveLaunchOf(wire, o.replyMs), before))
        throw new Error('准备期间 Mirasim 启动配置已修改，未覆盖');
    }
    const previous = saved && before.command === saved.command ? saved.previous : before;
    const next: RecordData = {
      schema: 1,
      previous,
      command: executable,
      sourceHash,
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
