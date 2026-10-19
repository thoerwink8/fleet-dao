// 真 Temporal 服务端测试要的命令行（temporal CLI）：固定版本、核实、本机准备、带期限的启动（#3282）。
// 版本和 Linux 校验和只有一份：deploy/france.sh 的 TEMPORAL_CLI_VERSION / TEMPORAL_CLI_SHA256（CI 也读它）。
// 本文件是纯逻辑加可注入的运输：测试不连网络、不真起 temporal。三态纪律：读不到、版本不对、卡住、执行失败各自明确失败，
// 并写出可执行的 pnpm 修复命令；绝不静默退回 SDK 随包下载（它没有整体期限，卡在 .downloading 上分不清是哪一步）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 本机准备命令（package.json 的 temporal:cli）。所有失败信息都指向它。 */
export const FIX_COMMAND = 'pnpm temporal:cli';
/** 法国部署装的位置（deploy/france.sh）；只在 Linux 上当候选。 */
export const FRANCE_CLI_PATH = '/opt/fleet-dao/temporal/bin/temporal';
export const PROBE_TIMEOUT_MS = 15_000;
export const START_DEADLINE_MS = 60_000;
export const INSTALL_TOTAL_MS = 300_000;
export const INSTALL_ATTEMPTS = 3;

/** 失败阶段：准备（缺失/坏路径/错版本/卡住/执行失败）与 SDK 起服务端（启动+连接，SDK 把两步合在一个调用里，无法再分）。 */
export type CliStage = 'missing' | 'bad-path' | 'version' | 'hung' | 'exec-failed' | 'start';

const STAGE_LABEL: Record<CliStage, string> = {
  missing: '准备·命令行缺失',
  'bad-path': '准备·路径不可用',
  version: '准备·版本不符',
  hung: '准备·命令行卡住',
  'exec-failed': '准备·命令行执行失败',
  start: '启动或连接',
};

export class TemporalCliError extends Error {
  readonly stage: CliStage;
  constructor(stage: CliStage, detail: string) {
    super(`[真 Temporal 服务端·${STAGE_LABEL[stage]}] ${detail}`);
    this.name = 'TemporalCliError';
    this.stage = stage;
  }
}

export type CliResult =
  | { ok: true; path: string; version: string }
  | { ok: false; stage: CliStage; message: string };

const fail = (stage: CliStage, detail: string): CliResult => ({
  ok: false,
  stage,
  message: new TemporalCliError(stage, detail).message,
});

export interface CliPin {
  version: string;
  sha256: string;
}

/** 从 deploy/france.sh 的文本读固定版本和 Linux amd64 校验和；读不全返回原因字符串。 */
export function parsePin(text: string): CliPin | string {
  const version = /^TEMPORAL_CLI_VERSION=(\S+)/m.exec(text)?.[1];
  const sha256 = /^TEMPORAL_CLI_SHA256=(\S+)/m.exec(text)?.[1];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version))
    return `deploy/france.sh 里没读到 TEMPORAL_CLI_VERSION（读到 ${version ?? '空'}）`;
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256))
    return `deploy/france.sh 里没读到 TEMPORAL_CLI_SHA256（读到 ${sha256 ?? '空'}）`;
  return { version, sha256 };
}

/**
 * 各平台归档的 sha256（取自官方 release 的 checksums.txt，按版本分）。linux_amd64 不在这里：它只认 deploy/france.sh 那一份。
 * 升版本必须同步补这张表，否则 pnpm temporal:cli 明确失败（不下载未核实的归档）。
 */
export const ARCHIVE_SHA256: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '1.9.1': {
    darwin_amd64: '48cdd6c84c56e27ae8e4d9a47052b89289a9c552dee029b49dd312c6fb72873f',
    darwin_arm64: '41e0425378fcb4fb5766340b97435e20fe47bbff2d7bf644ec2d51f7662b7c56',
    linux_arm64: '6c57c352d52fc3df34412376fd9ba6f74b7e3ace8e426e6cba8600156d36a145',
    windows_amd64: '42637464c337a3da203fbd4e8c688e4b2d511fd42bd19c337c0422e923a7b619',
    windows_arm64: 'cfdfe43e69a2261191148294b1f7e3a7088ef8d3dc1ab1909b115b1784b6c6fe',
  },
};

/** `<os>_<arch>`，认不出返回 undefined。 */
export function platformKey(platform: string, arch: string): string | undefined {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  return os && cpu ? `${os}_${cpu}` : undefined;
}

export function archiveSha(pin: CliPin, key: string): string | undefined {
  return key === 'linux_amd64' ? pin.sha256 : ARCHIVE_SHA256[pin.version]?.[key];
}

export function archiveUrl(version: string, key: string): string {
  return `https://github.com/temporalio/cli/releases/download/v${version}/temporal_cli_${version}_${key}.tar.gz`;
}

/** 受管缓存位置；和 CI 的 ~/.cache/fleet-temporal-cli/<版本>/temporal 同一布局。 */
export function managedCliPath(version: string, platform: string, home: string): string {
  return join(
    home,
    '.cache',
    'fleet-temporal-cli',
    version,
    platform === 'win32' ? 'temporal.exe' : 'temporal',
  );
}

export interface RunResult {
  status: number | null;
  signal?: string | null;
  error?: (Error & { code?: string }) | undefined;
  stdout: string;
  stderr: string;
}
export interface ProbeDeps {
  kind(path: string): 'file' | 'dir' | 'none';
  run(path: string, args: string[], timeoutMs: number): RunResult;
}

export const realProbeDeps: ProbeDeps = {
  kind(path) {
    try {
      return statSync(path).isDirectory() ? 'dir' : 'file';
    } catch {
      return 'none';
    }
  },
  run(path, args, timeoutMs) {
    const r = spawnSync(path, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
    return {
      status: r.status,
      signal: r.signal,
      error: r.error as RunResult['error'],
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    };
  },
};

/** 核一条命令行路径：存在、能跑、版本等于固定版本。卡住有期限（PROBE_TIMEOUT_MS）。 */
export function probeCli(
  path: string,
  version: string,
  deps: ProbeDeps = realProbeDeps,
  timeoutMs = PROBE_TIMEOUT_MS,
): CliResult {
  const kind = deps.kind(path);
  if (kind === 'none') return fail('bad-path', `${path} 不存在。先跑 ${FIX_COMMAND}`);
  if (kind === 'dir') return fail('bad-path', `${path} 是目录不是 temporal 可执行文件。先跑 ${FIX_COMMAND}`);
  const r = deps.run(path, ['--version'], timeoutMs);
  if (r.error?.code === 'ETIMEDOUT')
    return fail('hung', `${path} --version ${timeoutMs / 1000} 秒没返回，已强杀。先跑 ${FIX_COMMAND}`);
  if (r.error) return fail('bad-path', `${path} 起不来（${r.error.message}）。先跑 ${FIX_COMMAND}`);
  if (r.status !== 0)
    return fail(
      'exec-failed',
      `${path} --version 退出 ${r.status ?? `信号 ${r.signal}`}：${r.stderr.trim().slice(0, 200)}。先跑 ${FIX_COMMAND}`,
    );
  const got = /\bversion (\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
  if (got !== version)
    return fail(
      'version',
      `${path} 是 ${got ?? `读不出版本（输出 ${r.stdout.trim().slice(0, 80)}）`}，仓内固定 ${version}。先跑 ${FIX_COMMAND}`,
    );
  return { ok: true, path, version };
}

export interface ResolveInput {
  env: Record<string, string | undefined>;
  version: string;
  platform: string;
  home: string;
  deps?: ProbeDeps | undefined;
}

/**
 * 找到并核实本次要用的命令行：FLEET_TEST_TEMPORAL_CLI 显式路径优先（坏了就是坏了，不回退到别处）；
 * 没给就用受管缓存，Linux 再看法国部署的位置。都没有：缺失，明确失败。
 */
export function resolveCli(input: ResolveInput): CliResult {
  const deps = input.deps ?? realProbeDeps;
  const explicit = input.env.FLEET_TEST_TEMPORAL_CLI?.trim();
  if (explicit) return probeCli(explicit, input.version, deps);
  const candidates = [managedCliPath(input.version, input.platform, input.home)];
  if (input.platform === 'linux') candidates.push(FRANCE_CLI_PATH);
  const found = candidates.find((p) => deps.kind(p) !== 'none');
  if (!found)
    return fail(
      'missing',
      `没有 FLEET_TEST_TEMPORAL_CLI，受管缓存也没有（找过 ${candidates.join('、')}）。先跑 ${FIX_COMMAND}，不会隐式下载`,
    );
  return probeCli(found, input.version, deps);
}

/**
 * 给「起服务端」加期限。迟到才起来的服务端归我们回收：超时后 start 迟到成功，立刻 dispose（不能 Promise.race 完就不管）。
 * 一直不返回的 start 没有句柄可收，只能明确报「启动或连接」超时；进程随测试进程退出。
 */
export function startWithDeadline<T>(
  start: () => Promise<T>,
  dispose: (value: T) => Promise<void>,
  ms: number,
  onLateDisposeError: (e: unknown) => void = () => {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(
        new TemporalCliError(
          'start',
          `${ms / 1000} 秒内没起好（命令行已核实，卡在启动或连接）；迟到起来的服务端会被回收`,
        ),
      );
    }, ms);
    start().then(
      (value) => {
        clearTimeout(timer);
        if (settled) dispose(value).catch(onLateDisposeError);
        else {
          settled = true;
          resolve(value);
        }
      },
      (e) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new TemporalCliError('start', `起服务端失败：${e instanceof Error ? e.message : String(e)}`));
      },
    );
  });
}

// ---- 本机准备（pnpm temporal:cli）

export interface InstallDeps {
  /** 下载整个归档；ms 是这一次的整体期限。 */
  download(url: string, ms: number): Promise<Uint8Array>;
  /** 把归档解到目录。 */
  extract(archive: string, dest: string): { ok: boolean; message: string };
  probe: ProbeDeps;
  now(): number;
  log(line: string): void;
}

export const realInstallDeps: InstallDeps = {
  async download(url, ms) {
    // Node 的全局 fetch 默认不认 HTTPS_PROXY；本机走代理上网时要显式打开（只改本进程，不动全局配置）。
    const g = http as unknown as { setGlobalProxyFromEnv?: () => unknown };
    g.setGlobalProxyFromEnv?.();
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  extract(archive, dest) {
    const r = spawnSync('tar', ['-xzf', archive, '-C', dest], { encoding: 'utf8', timeout: 60_000 });
    return r.status === 0 && !r.error
      ? { ok: true, message: '' }
      : { ok: false, message: r.error?.message ?? (r.stderr.trim() || `tar 退出 ${r.status}`) };
  },
  probe: realProbeDeps,
  now: () => Date.now(),
  log: (l) => console.log(l),
};

export interface InstallInput {
  pin: CliPin;
  platform: string;
  arch: string;
  home: string;
  deps?: InstallDeps;
  totalMs?: number;
  attempts?: number;
}

/**
 * 把固定版本的命令行装进受管缓存：校验和对（france.sh 与上面的表）、整体期限、有界重试、解到临时目录、
 * 核过版本才原子改名到位。任何失败都清掉临时目录，只有改名成功的文件才算「已准备」（.installing-* 不算）。
 * 不动 PATH、SDK 缓存和别的文件。
 */
export async function installCli(input: InstallInput): Promise<CliResult> {
  const deps = input.deps ?? realInstallDeps;
  const key = platformKey(input.platform, input.arch);
  if (!key)
    return fail(
      'missing',
      `不认识的平台 ${input.platform}/${input.arch}，请自己装 ${input.pin.version} 并设 FLEET_TEST_TEMPORAL_CLI`,
    );
  const sha = archiveSha(input.pin, key);
  if (!sha)
    return fail(
      'missing',
      `仓内没有 ${input.pin.version} 在 ${key} 的归档校验和（packages/conventions/src/temporal-cli.ts 的 ARCHIVE_SHA256），不下载未核实的归档`,
    );
  const final = managedCliPath(input.pin.version, input.platform, input.home);
  const existing = resolveCli({
    env: { FLEET_TEST_TEMPORAL_CLI: final },
    version: input.pin.version,
    platform: input.platform,
    home: input.home,
    deps: deps.probe,
  });
  if (existing.ok) return existing;

  const dir = join(input.home, '.cache', 'fleet-temporal-cli', input.pin.version);
  mkdirSync(dir, { recursive: true });
  const totalMs = input.totalMs ?? INSTALL_TOTAL_MS;
  const attempts = input.attempts ?? INSTALL_ATTEMPTS;
  const started = deps.now();
  const url = archiveUrl(input.pin.version, key);
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const left = totalMs - (deps.now() - started);
    if (left <= 0) break;
    deps.log(`下载 ${url}（第 ${attempt}/${attempts} 次，剩 ${Math.round(left / 1000)} 秒）`);
    const tmp = mkdtempSync(join(dir, '.installing-'));
    try {
      let data: Uint8Array;
      try {
        data = await deps.download(url, left);
      } catch (e) {
        lastError = `下载失败：${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      const got = createHash('sha256').update(data).digest('hex');
      if (got !== sha)
        return fail(
          'exec-failed',
          `归档校验和不符（要 ${sha}，得 ${got}）。已丢弃，不安装；这不是临时故障，不重试`,
        );
      const archive = join(tmp, 'archive.tar.gz');
      writeFileSync(archive, data);
      const out = join(tmp, 'out');
      mkdirSync(out);
      const x = deps.extract(archive, out);
      if (!x.ok) {
        lastError = `解包失败：${x.message}`;
        continue;
      }
      const bin = join(out, input.platform === 'win32' ? 'temporal.exe' : 'temporal');
      if (!existsSync(bin)) {
        lastError = `归档里没有 ${bin.slice(out.length + 1)}（有 ${readdirSync(out).join('、') || '空'}）`;
        continue;
      }
      if (input.platform !== 'win32') chmodSync(bin, 0o755);
      const probed = probeCli(bin, input.pin.version, deps.probe);
      if (!probed.ok) return probed;
      renameSync(bin, final);
      return { ok: true, path: final, version: input.pin.version };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return fail(
    'missing',
    `${lastError || '整体期限用完'}（共试 ${attempts} 次、期限 ${totalMs / 1000} 秒）。网络恢复后重跑 ${FIX_COMMAND}，或自己装好 ${input.pin.version} 并设 FLEET_TEST_TEMPORAL_CLI`,
  );
}

export function defaultHome(): string {
  return homedir();
}
