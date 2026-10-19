import { createHash } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { fsRepo } from './repo.ts';
import {
  type PreparedTemporalCli,
  prepareTemporalCli,
  registerTemporalCli,
  type TemporalCliOptions,
  temporalTestVersion,
  verifyTemporalCli,
} from './temporal-test-cli.ts';

const TEMPORAL_RELEASE_BASE = 'https://github.com/temporalio/cli/releases/download';
const TEMPORAL_CLI_CHECKSUMS: Record<string, Record<string, string>> = {
  '1.9.1': {
    darwin_arm64: '41e0425378fcb4fb5766340b97435e20fe47bbff2d7bf644ec2d51f7662b7c56',
    darwin_amd64: '48cdd6c84c56e27ae8e4d9a47052b89289a9c552dee029b49dd312c6fb72873f',
    linux_arm64: '6c57c352d52fc3df34412376fd9ba6f74b7e3ace8e426e6cba8600156d36a145',
    linux_amd64: '09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5',
    windows_amd64: '42637464c337a3da203fbd4e8c688e4b2d511fd42bd19c337c0422e923a7b619',
  },
};

export const TEMPORAL_CLI_INSTALL_ATTEMPTS = 3;
export const TEMPORAL_CLI_INSTALL_DEADLINE_MS = 15 * 60 * 1000;
export const TEMPORAL_CLI_DOWNLOAD_TIMEOUT_MS = 60 * 1000;

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

export interface TemporalCliArtifact {
  version: string;
  platform: SupportedPlatform;
  arch: 'arm64' | 'x64';
  target: string;
  archive: string;
  url: string;
  sha256: string;
  executable: string;
}

export interface TemporalCliInstallOptions extends TemporalCliOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  /** 仅供本地测试注入假归档；正式入口始终从仓内固定版本和校验和生成。 */
  artifact?: TemporalCliArtifact;
  attempts?: number;
  deadlineMs?: number;
  attemptTimeoutMs?: number;
  download?: (url: string, destination: string, signal: AbortSignal) => Promise<void>;
}

export interface InstalledTemporalCli extends PreparedTemporalCli {
  artifact: TemporalCliArtifact;
  downloaded: boolean;
}

function installError(detail: string, cause?: unknown): Error {
  return new Error(`Temporal CLI 安装失败：${detail}`, { cause });
}

function platformTarget(
  platform: NodeJS.Platform,
  arch: string,
): {
  platform: SupportedPlatform;
  arch: 'arm64' | 'x64';
  target: string;
} {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')
    throw installError(`当前平台不支持：${platform}/${arch}（支持 macOS、Linux、Windows）`);
  if (arch !== 'arm64' && arch !== 'x64') throw installError(`当前架构不支持：${platform}/${arch}`);
  if (platform === 'win32' && arch !== 'x64') throw installError('Windows 只支持 x64');
  return {
    platform,
    arch,
    target: `${platform === 'win32' ? 'windows' : platform}_${arch === 'x64' ? 'amd64' : 'arm64'}`,
  };
}

export function temporalCliArtifact(
  root: string,
  platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): TemporalCliArtifact {
  const version = temporalTestVersion(fsRepo(root));
  const selected = platformTarget(platform, arch);
  const sha256 = TEMPORAL_CLI_CHECKSUMS[version]?.[selected.target];
  if (!sha256)
    throw installError(
      `仓内固定版本 ${version} 没有 ${selected.target} 的已审定 SHA-256；升版本时请同时补齐 packages/conventions/src/temporal-cli-install.ts`,
    );
  const archive = `temporal_cli_${version}_${selected.target}.tar.gz`;
  return {
    version,
    ...selected,
    archive,
    url: `${TEMPORAL_RELEASE_BASE}/v${version}/${archive}`,
    sha256,
    executable: selected.platform === 'win32' ? 'temporal.exe' : 'temporal',
  };
}

function managedCliRoot(home: string, artifact: TemporalCliArtifact): string {
  return join(home, '.fleet-dao', 'test-tools', 'temporal-cli', artifact.version, artifact.target);
}

function hashFile(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function octalField(header: Buffer, start: number, end: number): number {
  const value = header.subarray(start, end).toString('ascii').replace(/\0/g, '').trim();
  return value === '' ? 0 : Number.parseInt(value, 8);
}

function tarPath(header: Buffer): string {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}

function extractTemporalBinary(archive: string, destination: string, executable: string): void {
  let tar: Buffer;
  try {
    tar = gunzipSync(readFileSync(archive));
  } catch (cause) {
    throw installError(`归档不是可读的 gzip 文件：${basename(archive)}`, cause);
  }
  let offset = 0;
  let found: Buffer | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octalField(header, 124, 136);
    const type = header[156];
    const path = tarPath(header);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw installError(`归档条目越过文件末尾：${path}`);
    if (type !== 0 && type !== 48 && type !== undefined && size !== 0)
      throw installError(`归档含不支持的非普通文件条目：${path}`);
    if ((type === 0 || type === 48 || type === undefined) && basename(path) === executable) {
      if (found) throw installError(`归档里有多个 ${executable} 文件`);
      found = Buffer.from(tar.subarray(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!found) throw installError(`归档里找不到 ${executable}`);
  writeFileSync(destination, found, { mode: 0o755, flag: 'wx' });
}

async function downloadOfficial(url: string, destination: string, signal: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    throw installError(`下载被中止或失败：${url}`, cause);
  }
  if (!response.ok) throw installError(`官方下载返回 HTTP ${response.status}：${url}`);
  if (!response.body) throw installError(`官方下载没有响应内容：${url}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination), { signal });
  } catch (cause) {
    throw installError(`下载内容没有完整写入：${url}`, cause);
  }
}

async function downloadWithRetry(
  artifact: TemporalCliArtifact,
  destination: string,
  options: Required<Pick<TemporalCliInstallOptions, 'attempts' | 'deadlineMs' | 'attemptTimeoutMs'>> & {
    download: NonNullable<TemporalCliInstallOptions['download']>;
  },
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const remaining = options.deadlineMs - (Date.now() - started);
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timeoutMs = Math.min(options.attemptTimeoutMs, remaining);
    const timer = setTimeout(() => controller.abort(new Error(`单次下载超过 ${timeoutMs}ms`)), timeoutMs);
    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.download(artifact.url, destination, controller.signal),
        new Promise<never>((_, reject) => {
          raceTimer = setTimeout(() => reject(new Error(`单次下载超过 ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (raceTimer) clearTimeout(raceTimer);
      return;
    } catch (cause) {
      clearTimeout(timer);
      if (raceTimer) clearTimeout(raceTimer);
      lastError = cause;
      rmSync(destination, { force: true });
      if (attempt < options.attempts && Date.now() - started < options.deadlineMs) continue;
    }
  }
  throw installError(
    `下载重试用尽（${options.attempts} 次、总期限 ${options.deadlineMs}ms）：${artifact.url}`,
    lastError,
  );
}

function existingPrepared(
  root: string,
  home: string,
  options: TemporalCliInstallOptions,
): PreparedTemporalCli | undefined {
  try {
    return prepareTemporalCli(root, {
      ...options,
      home,
      env: {},
    });
  } catch {
    return undefined;
  }
}

export async function installTemporalCli(
  root: string,
  options: TemporalCliInstallOptions = {},
): Promise<InstalledTemporalCli> {
  const artifact = options.artifact ?? temporalCliArtifact(root, options.platform, options.arch);
  const home = options.home ?? homedir();
  const already = existingPrepared(root, home, options);
  if (already) return { ...already, artifact, downloaded: false };

  const managedRoot = managedCliRoot(home, artifact);
  const target = join(managedRoot, artifact.executable);
  mkdirSync(dirname(managedRoot), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(dirname(managedRoot), `.temporal-cli-${artifact.target}-`));
  const archive = join(stage, artifact.archive);
  const stagedBinary = join(stage, artifact.executable);
  let moved = false;
  try {
    await downloadWithRetry(artifact, archive, {
      attempts: options.attempts ?? TEMPORAL_CLI_INSTALL_ATTEMPTS,
      deadlineMs: options.deadlineMs ?? TEMPORAL_CLI_INSTALL_DEADLINE_MS,
      attemptTimeoutMs: options.attemptTimeoutMs ?? TEMPORAL_CLI_DOWNLOAD_TIMEOUT_MS,
      download: options.download ?? downloadOfficial,
    });
    if (hashFile(archive) !== artifact.sha256) throw installError(`SHA-256 校验不符：${artifact.archive}`);
    extractTemporalBinary(archive, stagedBinary, artifact.executable);
    verifyTemporalCli(stagedBinary, artifact.version, options);
    mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
    try {
      try {
        renameSync(stagedBinary, target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        rmSync(target, { force: true });
        renameSync(stagedBinary, target);
      }
    } catch (cause) {
      throw installError(`原子落盘失败：${target}`, cause);
    }
    moved = true;
    const registered = registerTemporalCli(root, target, { ...options, home });
    return { ...registered, artifact, downloaded: true };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    if (!moved) rmSync(target, { force: true });
  }
}
