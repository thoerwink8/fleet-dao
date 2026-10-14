// reclaude 健康维护：预热 daemon、记各线路测速、检查并在空闲时更新。
// 只调 reclaude 命令，不读 reclaude 的设备密钥目录；线路保持 reclaude 自己的 auto 模式，不设线路。
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runningSessions } from './migrate.ts';

export const THROTTLE_MS = 6 * 60 * 60_000;
export const LOG_LIMIT_BYTES = 1024 * 1024;
export const TIMEOUT = { gateway: 15_000, update: 5 * 60_000, other: 10_000 } as const;

export interface HealthEnv {
  home: string;
  platform: NodeJS.Platform;
  /** reclaude 可执行文件的绝对路径；测试里指向假脚本 */
  bin: string;
  now: () => Date;
  /** 空闲判断；返回 false 或抛错都不装更新 */
  idle?: () => boolean;
  /** 覆盖超时（测试用） */
  timeouts?: Partial<Record<keyof typeof TIMEOUT, number>>;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  ms: number;
  /** 没跑成的原因：超时、起不来或非零退出 */
  error?: string;
}

export interface GatewayResult {
  url: string;
  ok: boolean;
  ms: number | null;
}

export interface GatewayRecord {
  at: string;
  platform: string;
  current: string | null;
  healthy: boolean | null;
  results: GatewayResult[];
}

export interface UpdateRecord {
  checkedAt: string;
  status: 'ok' | 'failed';
  current?: string;
  latest?: string;
  hasNew?: boolean;
  /** 有新版但没装：busy=有在途回合，unknown=判不了空闲 */
  pending?: 'busy' | 'unknown';
  updated?: { at: string; ok: boolean; error?: string };
  error?: string;
}

export interface HealthState {
  gatewayTestAt?: string;
  updateCheckAt?: string;
}

export const healthDir = (home: string): string => join(home, '.fleet-dao', 'mirasim-reclaude');
export const gatewayLog = (home: string): string => join(healthDir(home), 'gateway-test.jsonl');
export const updateFile = (home: string): string => join(healthDir(home), 'reclaude-update.json');
export const stateFile = (home: string): string => join(healthDir(home), 'health-state.json');
export const healthLog = (home: string): string => join(healthDir(home), 'health.log');

const timeoutOf = (env: HealthEnv, key: keyof typeof TIMEOUT): number => env.timeouts?.[key] ?? TIMEOUT[key];

/** 顺序同迁移用的查找：用户 ~/.local/bin、Windows 安装目录、PATH；找不到返回 undefined */
export function findReclaude(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const exe = platform === 'win32' ? 'reclaude.exe' : 'reclaude';
  const candidates = [join(home, '.local', 'bin', exe)];
  if (platform === 'win32' && env.LOCALAPPDATA)
    candidates.push(join(env.LOCALAPPDATA, 'Programs', 'reclaude', 'bin', exe));
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH ?? env.Path ?? '').split(sep)) if (dir) candidates.push(join(dir, exe));
  return candidates.find((file) => existsSync(file));
}

export function runReclaude(env: HealthEnv, args: string[], timeoutMs: number): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      env.bin,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, out, err) => {
        const ms = Date.now() - started;
        // reclaude 的管理命令把结果写在 stderr，两路合在一起解析
        const stdout = `${out ?? ''}\n${err ?? ''}`;
        if (!error) return resolve({ ok: true, stdout, ms });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        const reason = e.killed
          ? `超时（${timeoutMs / 1000} 秒）`
          : typeof e.code === 'number'
            ? `退出码 ${e.code}`
            : `起不来（${e.code ?? 'unknown'}）`;
        resolve({ ok: false, stdout, ms, error: reason });
      },
    );
  });
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function truncateHalf(file: string): void {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
}

/** 追加一行；文件已超 1MB 先截掉旧的一半 */
function appendLine(file: string, line: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  if (existsSync(file) && statSync(file).size > LOG_LIMIT_BYTES) truncateHalf(file);
  appendFileSync(file, `${line}\n`);
}

export function log(env: HealthEnv, line: string): void {
  try {
    appendLine(healthLog(env.home), `${env.now().toISOString()} ${line}`);
  } catch {
    // 日志写不了不影响主流程
  }
}

export async function ensureDaemon(env: HealthEnv): Promise<RunResult> {
  const r = await runReclaude(env, ['daemon', '--detach'], timeoutOf(env, 'other'));
  log(env, r.ok ? `daemon --detach 完成 ${r.ms}ms` : `daemon --detach 没成：${r.error}`);
  return r;
}

export function parseStatus(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** 行形如「OK      2. https://x  672ms」；失败行的前缀不是 OK，耗时可能没有 */
export function parseGatewayTest(text: string): GatewayResult[] {
  const results: GatewayResult[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+\d+\.\s+(https?:\/\/\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    // 耗时可能是 672ms、1.2s（Go 的 Duration 写法），也可能是 1.234567ms
    const t = /(\d+(?:\.\d+)?)\s*(ms|s)\b/.exec(m[3] as string);
    const ok = (m[1] as string).toUpperCase() === 'OK';
    const ms = ok && t ? Math.round(Number(t[1]) * (t[2] === 's' ? 1000 : 1)) : null;
    results.push({ url: m[2] as string, ok, ms });
  }
  return results;
}

export interface GatewayOutcome {
  ok: boolean;
  record?: GatewayRecord;
  error?: string;
}

export async function gatewayTest(env: HealthEnv): Promise<GatewayOutcome> {
  const test = await runReclaude(env, ['config', 'gateway', 'test'], timeoutOf(env, 'gateway'));
  const fail = (error: string): GatewayOutcome => {
    log(env, error);
    return { ok: false, error };
  };
  if (!test.ok) return fail(`线路测速没查成：${test.error}`);
  const results = parseGatewayTest(test.stdout);
  if (results.length === 0) return fail('线路测速没查成：输出里认不出线路行');
  const status = await runReclaude(env, ['status'], timeoutOf(env, 'other'));
  const s = status.ok ? parseStatus(status.stdout) : {};
  const record: GatewayRecord = {
    at: env.now().toISOString(),
    platform: env.platform,
    current: s.gateway_url || null,
    healthy: s.gateway_healthy === undefined ? null : s.gateway_healthy === 'true',
    results,
  };
  appendLine(gatewayLog(env.home), JSON.stringify(record));
  log(
    env,
    `线路测速完成：${results.filter((r) => r.ok).length}/${results.length} 通，当前 ${record.current ?? '未知'}`,
  );
  return { ok: true, record };
}

export function parseVersions(text: string): { current?: string; latest?: string } {
  const current = /当前版本[:：]\s*(\S+)/.exec(text)?.[1];
  const latest = /最新版本[:：]\s*(\S+)/.exec(text)?.[1];
  return { ...(current ? { current } : {}), ...(latest ? { latest } : {}) };
}

export async function updateCheck(env: HealthEnv): Promise<UpdateRecord> {
  const checkedAt = env.now().toISOString();
  const check = await runReclaude(env, ['update', '--check'], timeoutOf(env, 'other'));
  const v = check.ok ? parseVersions(check.stdout) : {};
  let record: UpdateRecord;
  if (!check.ok || !v.current || !v.latest) {
    const why = check.ok ? '输出里认不出版本号' : (check.error ?? '未知');
    record = { checkedAt, status: 'failed', error: `更新检查没查成：${why}` };
  } else {
    const hasNew = v.current !== v.latest;
    record = { checkedAt, status: 'ok', current: v.current, latest: v.latest, hasNew };
    if (hasNew) {
      let idle: boolean | undefined;
      try {
        if (env.idle) idle = env.idle();
        else {
          const sessions = runningSessions(env.home);
          // 有会话记录没查成：判不了，不当空闲。
          idle = sessions.running > 0 ? false : sessions.unknown.length ? undefined : true;
        }
      } catch {
        idle = undefined; // 会话记录读不了或状态不认识：判不了就不装
      }
      if (idle === true) {
        const up = await runReclaude(env, ['update'], timeoutOf(env, 'update'));
        record.updated = {
          at: env.now().toISOString(),
          ok: up.ok,
          ...(up.ok ? {} : { error: up.error ?? '未知' }),
        };
      } else record.pending = idle === false ? 'busy' : 'unknown';
    }
  }
  writeJson(updateFile(env.home), record);
  let line = record.error ?? `更新检查 ${record.current} -> ${record.latest}`;
  if (record.updated) line += record.updated.ok ? '，已更新' : `，更新没成：${record.updated.error}`;
  else if (record.pending)
    line += `，有新版待装（${record.pending === 'busy' ? '有在途回合' : '判不了空闲'}）`;
  log(env, line);
  return record;
}

export function readState(home: string): HealthState {
  return readJson<HealthState>(stateFile(home)) ?? {};
}

function due(last: string | undefined, now: Date): boolean {
  const t = last ? Date.parse(last) : Number.NaN;
  return !Number.isFinite(t) || t > now.getTime() || now.getTime() - t >= THROTTLE_MS;
}

/** 开会话同步用：daemon 每次预热；测速和更新检查各距上次满 6 小时才跑（失败也算跑过，免得反复撞） */
export async function runSync(env: HealthEnv): Promise<void> {
  await ensureDaemon(env);
  const state = readState(env.home);
  const now = env.now();
  if (due(state.gatewayTestAt, now)) {
    state.gatewayTestAt = now.toISOString();
    writeJson(stateFile(env.home), state);
    await gatewayTest(env);
  }
  if (due(state.updateCheckAt, now)) {
    state.updateCheckAt = now.toISOString();
    writeJson(stateFile(env.home), state);
    await updateCheck(env);
  }
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

export function readGatewayRecords(home: string): GatewayRecord[] {
  const file = gatewayLog(home);
  if (!existsSync(file)) return [];
  const out: GatewayRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as GatewayRecord);
    } catch {
      // 截断可能留下半行，跳过
    }
  }
  return out;
}

/** 人话汇总：daemon 现状现查，其余读记录；每一项查不到都明说 */
export async function summary(env: HealthEnv): Promise<string> {
  const lines: string[] = [];
  const st = await runReclaude(env, ['status'], timeoutOf(env, 'other'));
  const s = st.ok ? parseStatus(st.stdout) : undefined;
  if (!s) lines.push(`daemon：没查成（${st.error}）`);
  else {
    const ver = s.daemon_version ? `（${s.daemon_version}）` : '';
    lines.push(`daemon：${s.daemon_running === 'true' ? '在运行' : '没运行'}${ver}`);
    const healthy =
      s.gateway_healthy === 'true' ? '健康' : s.gateway_healthy === 'false' ? '不健康' : '健康状态没查成';
    lines.push(`当前线路：${s.gateway_url ?? '没查成'}（${healthy}）`);
  }
  const records = readGatewayRecords(env.home);
  const last = records[records.length - 1];
  if (!last) lines.push('线路测速：还没有记录');
  else {
    const cur = s?.gateway_url ?? last.current;
    if (cur) {
      const mine = [...records].reverse().find((r) => r.results.some((x) => x.url === cur));
      const hit = mine?.results.find((x) => x.url === cur);
      lines.push(
        hit && mine
          ? `当前线路最近一次测速：${hit.ok ? `${hit.ms}ms` : '失败'}（${mine.at}）`
          : '当前线路最近一次测速：没有记录',
      );
    }
    lines.push(`各线路最近 5 次中位数（共 ${records.length} 次记录，最近 ${last.at}）：`);
    const recent = records.slice(-5);
    const urls = [...new Set(recent.flatMap((r) => r.results.map((x) => x.url)))];
    const rows = urls
      .map((url) => {
        const all = recent.flatMap((r) => r.results.filter((x) => x.url === url));
        const ok = all.filter((x) => x.ok && x.ms !== null).map((x) => x.ms as number);
        return { url, med: median(ok), fail: all.filter((x) => !x.ok).length, n: all.length };
      })
      .sort((a, b) => (a.med ?? Number.POSITIVE_INFINITY) - (b.med ?? Number.POSITIVE_INFINITY));
    for (const r of rows)
      lines.push(
        `  ${r.url}  ${r.med === undefined ? '全部失败' : `${r.med}ms`}（${r.n} 次里失败 ${r.fail}）`,
      );
  }
  const u = readJson<UpdateRecord>(updateFile(env.home));
  if (!u) lines.push('reclaude 版本：还没检查过更新');
  else if (u.status === 'failed') lines.push(`reclaude 版本：${u.error}（${u.checkedAt}）`);
  else {
    const note = u.updated
      ? u.updated.ok
        ? '，已自动更新'
        : `，自动更新没成：${u.updated.error}`
      : u.hasNew
        ? `，有新版 ${u.latest} 待装（${u.pending === 'busy' ? '有在途回合' : '判不了空闲'}）`
        : '，已是最新';
    lines.push(`reclaude 版本：${u.current}${note}`);
    lines.push(`上次更新检查：${u.checkedAt}`);
  }
  return lines.join('\n');
}

export function defaultEnv(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): HealthEnv | undefined {
  const bin = findReclaude(home, platform);
  return bin ? { home, platform, bin, now: () => new Date() } : undefined;
}
