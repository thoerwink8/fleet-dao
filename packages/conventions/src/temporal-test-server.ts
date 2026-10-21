// 时间跳跃服务只消费已核验的制品；下载只在显式准备命令发生，不进入每条业务测试。
// 官方身份：https://github.com/temporalio/sdk-java/releases/tag/v1.40.0 （GitHub release asset digest）。
// existing-path：https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment#createTimeSkipping
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const TEST_SERVER_VERSION = '1.40.0';
export interface TestServerArtifact {
  archive: string;
  archiveSha: string;
  binarySha: string;
  member: string;
}
const artifact = (os: string, arch: string, archiveSha: string, binarySha: string): TestServerArtifact => {
  const stem = `temporal-test-server_${TEST_SERVER_VERSION}_${os}_${arch}`;
  return {
    archive: `${stem}.${os === 'windows' ? 'zip' : 'tar.gz'}`,
    archiveSha,
    binarySha,
    member: `${stem}/temporal-test-server${os === 'windows' ? '.exe' : ''}`,
  };
};
export const TEST_SERVER_ARTIFACTS: Readonly<Record<string, TestServerArtifact>> = {
  'linux-x64': artifact(
    'linux',
    'amd64',
    '524465a96274831e004326f6e2f2a5f3ef9aaed72c2069cf16c1d64b8b1ec3ca',
    '19defb9f7318c7cf249518b3642a735efb79876c2b6918afe312336476b796a5',
  ),
  'linux-arm64': artifact(
    'linux',
    'arm64',
    '1d712f6f1de8a97454185d335752d0f9ea8267797c340b55569312251f6670e9',
    'a968eca117487a0314acfc9738892acee6064c6db2dbd9fdb9b4f8823606460c',
  ),
  'darwin-x64': artifact(
    'macOS',
    'amd64',
    'bd48704369f9a0aa36f48bc904adb405fcbc6c651cddee965235cd8a23d2803a',
    '0aa60a4278bc313167f6d2e46cb362c95df2551384d7c593887e79f4a92aa4ac',
  ),
  'darwin-arm64': artifact(
    'macOS',
    'arm64',
    '483d6b6d75979b78efa6a93ee159e8eb3232e919fe7d3576fce6e90a167804ec',
    '3a9cd757fc118c0cf134c6fa16d5cf901a02985d02782a11029f7c2833e95cb6',
  ),
  'win32-x64': artifact(
    'windows',
    'amd64',
    '6bcd6136e4ee655d7143523f170c7aaf92ff8fe7b2417fb66ee142c4642486fe',
    'ff915e921dc74b491d08ddee9184f9eea94eab3aa8b9f1ce0e078377b5067051',
  ),
};
export function testServerArtifact(platform = process.platform, arch = process.arch): TestServerArtifact {
  const selected = TEST_SERVER_ARTIFACTS[`${platform}-${arch}`];
  if (!selected) throw failure(`未支持平台 ${platform}-${arch}`);
  return selected;
}
export function testServerCacheRoot(): string {
  return join(homedir(), '.cache', 'fleet-temporal-test-server');
}
export function testServerPath(a = testServerArtifact(), cacheRoot = testServerCacheRoot()): string {
  return join(cacheRoot, TEST_SERVER_VERSION, a.archiveSha, basename(a.member));
}
function failure(detail: string, cause?: unknown): Error {
  return new Error(
    `Temporal time-skipping preparation 失败：${detail}；先 pnpm test:temporal-server（业务测试不下载）`,
    { cause },
  );
}
function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function verify(path: string, sha: string): void {
  if (!lstatSync(path).isFile() || hash(path) !== sha) throw failure(`制品 SHA256 不符：${path}`);
}
/** 缺失、损坏均拒绝；不信自写 receipt，也不复用 SDK 的未知临时缓存。 */
export function requireTestServer(a = testServerArtifact(), cacheRoot = testServerCacheRoot()): string {
  const target = testServerPath(a, cacheRoot);
  try {
    verify(target, a.binarySha);
    return target;
  } catch (cause) {
    throw failure(`没有可用的已核验 binary：${target}`, cause);
  }
}
export interface TestServerPreparationPorts {
  download?: (url: string, path: string) => Promise<void>;
  extract?: (archive: string, destination: string, member: string) => void | Promise<void>;
}
function command(cmd: string, args: string[], timeout: number): Promise<void> {
  // execFile 的 callback 在子进程关闭后才回；等待实际终态，不用 Promise.race 留下后台下载/提取。
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
      (error, _stdout, stderr) => {
        if (error)
          reject(
            failure(
              `${cmd} 失败（exit=${error.code ?? 'unknown'}, signal=${error.signal ?? 'none'}）：${(stderr || error.message).slice(-2000)}`,
              error,
            ),
          );
        else resolve();
      },
    );
  });
}
/** curl 自身有界重试（最多三次；429 保留 stderr），外层硬期限避免网络准备悬挂。 */
export async function downloadTestServer(url: string, path: string): Promise<void> {
  await command(
    'curl',
    [
      '--fail',
      '--show-error',
      '--silent',
      '--location',
      '--connect-timeout',
      '10',
      '--max-time',
      '25',
      '--retry',
      '2',
      '--retry-max-time',
      '55',
      '--output',
      path,
      url,
    ],
    90_000,
  );
}
async function extractTestServer(archive: string, destination: string, member: string): Promise<void> {
  // Windows 自带 bsdtar 支持 zip；不让 Git 的 GNU tar 抢到这个路径。
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
      : 'tar';
  await command(tar, ['-xf', archive, '-C', destination, member], 30_000);
}
/** 不上锁、不读半截：各自准备独立临时文件，完整验过后 link 原子发布，竞争者只接收相同 SHA。 */
export async function installTestServer(
  a = testServerArtifact(),
  cacheRoot = testServerCacheRoot(),
  ports: TestServerPreparationPorts = {},
): Promise<string> {
  const target = testServerPath(a, cacheRoot);
  try {
    verify(target, a.binarySha);
    return target;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
      throw failure(`已有缓存损坏，不覆盖：${target}`, cause);
  }
  const dir = join(cacheRoot, TEST_SERVER_VERSION, a.archiveSha);
  mkdirSync(dir, { recursive: true });
  const staging = mkdtempSync(join(dir, '.prepare-'));
  try {
    const archive = join(staging, a.archive);
    await (ports.download ?? downloadTestServer)(
      `https://github.com/temporalio/sdk-java/releases/download/v${TEST_SERVER_VERSION}/${a.archive}`,
      archive,
    );
    verify(archive, a.archiveSha);
    await (ports.extract ?? extractTestServer)(archive, staging, a.member);
    const binary = join(staging, a.member);
    verify(binary, a.binarySha);
    chmodSync(binary, 0o755);
    try {
      linkSync(binary, target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }
    return requireTestServer(a, cacheRoot);
  } catch (cause) {
    throw failure(
      `准备固定制品 ${a.archive} 没成：${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
