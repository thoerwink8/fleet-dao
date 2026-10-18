// 固定 Go tar 的真安装端口；只由 cli-upgrade 的排空窗口调用。
// 官方完整新树暂存，验真后原子换入口；旧树保留，不在运行目录上解包。
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CliToolSpec, ProcResult, TarInstallResult } from './cli-upgrade.ts';

type Exec = (cmd: string, args: string[], timeout: number) => Promise<ProcResult>;
export interface GoInstallOptions {
  exec: Exec;
  fetch?: typeof fetch;
  sessions?: () => Promise<number>;
  platform?: string;
  arch?: string;
  /** 测试只映射落点，生产不暴露命令行覆盖。 */
  root?: string;
}
const LIMIT = 150 * 1024 * 1024;
const PATH = '/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin';
const ok = (stdout: string): ProcResult => ({ code: 0, stdout, stderr: '' });
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw e;
  }
}
async function download(fetcher: typeof fetch, url: string, limit: number): Promise<Buffer> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status} ${url}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) {
      await res.body.cancel().catch(() => undefined);
      throw new Error('下载超过大小上限');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function assertVersion(proc: ProcResult, version: string, os: string, arch: string): void {
  if (proc.code !== 0 || proc.timedOut || proc.stdout.trim() !== `go version go${version} ${os}/${arch}`) {
    throw new Error(`Go 版本核验失败：${proc.stderr || proc.stdout}`);
  }
}
export async function installGoTar(spec: CliToolSpec, options: GoInstallOptions): Promise<TarInstallResult> {
  let staging: string | undefined;
  let switched = false;
  let saved: string | undefined;
  let entry = '';
  const execute = options.exec;
  try {
    const os = options.platform ?? process.platform;
    const arch = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[options.arch ?? process.arch];
    if (os !== 'linux' || !arch)
      throw new Error(`不支持的 Go 宿主平台 ${os}/${options.arch ?? process.arch}`);
    if (
      spec.id !== 'go' ||
      spec.bin !== '/usr/local/bin/go' ||
      !spec.version ||
      !/^\d+\.\d+\.\d+$/.test(spec.version) ||
      spec.user
    )
      throw new Error('Go tar 配置不合法');
    const version = spec.version;
    const root = options.root ?? '';
    entry = join(root, '/usr/local/bin/go');
    const fixedPath = root ? `${root}/usr/local/go/bin:${root}/usr/local/bin:/usr/bin:/bin` : PATH;
    // PATH 由 exec 的清洁环境提供；生产端显式使用固定PATH，不采纳 shell profile。
    const pathProbe = async () => {
      const p = await execute(
        '/usr/bin/env',
        [
          '-i',
          `PATH=${fixedPath}`,
          'HOME=/root',
          'GOTOOLCHAIN=local',
          '/bin/sh',
          '-c',
          'command -v go && go version',
        ],
        20_000,
      );
      if (p.code !== 0 || p.timedOut || p.stdout.trim() !== `${entry}\ngo version go${version} ${os}/${arch}`)
        throw new Error(`固定PATH核验失败：${p.stderr || p.stdout}`);
    };
    const current = await execute(entry, ['version'], 20_000);
    if (current.code === 0 && current.stdout.trim() === `go version go${version} ${os}/${arch}`) {
      await pathProbe();
      return ok(`已是 ${version}，固定PATH与 go version 核验通过`);
    }
    // 不能让优先级更高的旧安装遮住新入口；不替用户删除或迁移它。
    if (!(await absent(join(root, '/usr/local/go/bin/go'))))
      throw new Error('/usr/local/go/bin/go 会遮住受管入口，保留原安装并拒绝切换');
    const fetcher = options.fetch ?? fetch;
    const releases: unknown = JSON.parse(
      (await download(fetcher, 'https://go.dev/dl/?mode=json&include=all', 10 * 1024 * 1024)).toString(),
    );
    if (!Array.isArray(releases)) throw new Error('官方版本清单不是数组');
    const release = releases.find((r) => r?.version === `go${version}`);
    const filename = `go${version}.${os}-${arch}.tar.gz`;
    const archive = Array.isArray(release?.files)
      ? release.files.find(
          (f: Record<string, unknown>) =>
            f.filename === filename &&
            f.os === os &&
            f.arch === arch &&
            f.kind === 'archive' &&
            f.version === `go${version}`,
        )
      : undefined;
    if (
      !archive ||
      !/^[a-f0-9]{64}$/.test(archive.sha256) ||
      !Number.isSafeInteger(archive.size) ||
      archive.size <= 0 ||
      archive.size > LIMIT
    )
      throw new Error('官方清单缺少精确架构、大小或SHA256');
    const bytes = await download(fetcher, `https://go.dev/dl/${filename}`, LIMIT);
    if (bytes.length !== archive.size || createHash('sha256').update(bytes).digest('hex') !== archive.sha256)
      throw new Error('Go 下载大小或SHA256不匹配');
    const base = join(root, '/usr/local/lib/fleet-go');
    await mkdir(base, { recursive: true, mode: 0o755 });
    staging = await mkdtemp(join(base, '.stage-'));
    const tar = join(staging, 'download.tar.gz');
    await writeFile(tar, bytes, { mode: 0o600 });
    const names = await execute('tar', ['-tzf', tar], 60_000);
    const types = await execute('tar', ['-tvzf', tar], 60_000);
    const entries = names.stdout.trim().split('\n');
    if (
      names.code !== 0 ||
      types.code !== 0 ||
      names.timedOut ||
      types.timedOut ||
      !entries.includes('go/bin/go') ||
      entries.some(
        (n) =>
          !/^go\//.test(n) ||
          /[\\\r]/.test(n) ||
          n.includes(String.fromCharCode(0)) ||
          n.split('/').some((part) => part === '..' || part === '.'),
      ) ||
      types.stdout
        .trim()
        .split('\n')
        .some((n) => !/^[-d]/.test(n))
    )
      throw new Error('Go tar 包含不安全路径或非普通文件/目录');
    const extracted = await execute(
      'tar',
      [
        '--extract',
        '--gzip',
        '--file',
        tar,
        '--directory',
        staging,
        '--no-same-owner',
        '--no-same-permissions',
      ],
      120_000,
    );
    if (extracted.code !== 0 || extracted.timedOut) throw new Error(`Go 解包失败：${extracted.stderr}`);
    const candidate = join(staging, 'go/bin/go');
    assertVersion(await execute(candidate, ['version'], 20_000), version, os, arch);
    await rm(tar);
    const installed = join(base, `${version}-${arch}-${randomUUID()}`);
    await rename(join(staging, 'go'), installed);
    await mkdir(dirname(entry), { recursive: true });
    if (!(await absent(entry))) {
      const info = await lstat(entry);
      saved = join(dirname(entry), `.go-backup-${randomUUID()}`);
      if (info.isSymbolicLink()) await symlink(await readlink(entry), saved);
      else if (info.isFile()) await copyFile(entry, saved);
      else throw new Error('现有Go入口不是普通文件或链接');
    }
    if (options.sessions) {
      try {
        if ((await options.sessions()) > 0)
          return {
            code: 1,
            refused: true,
            stdout: '',
            stderr: '切换前出现会话或排空不可读，保留旧入口，下次空闲重试',
          };
      } catch (err) {
        return {
          code: 1,
          refused: true,
          stdout: '',
          stderr: `切换前无法核实会话状态，保留旧入口，下次空闲重试：${String(err)}`,
        };
      }
    }
    const next = join(dirname(entry), `.go-next-${randomUUID()}`);
    await symlink(join(installed, 'bin/go'), next);
    await rename(next, entry);
    switched = true;
    assertVersion(await execute(entry, ['version'], 20_000), version, os, arch);
    await pathProbe();
    // 旧入口备份和完整树均保留，便于回退，不在本轮垃圾回收。
    return ok(`安装 ${version}，官方SHA256、go version与固定PATH核验通过`);
  } catch (err) {
    let detail = err instanceof Error ? err.message : String(err);
    if (switched) {
      try {
        if (saved) await rename(saved, entry);
        else await rm(entry);
      } catch (rollback) {
        detail += `；恢复旧入口失败：${String(rollback)}`;
      }
    }
    return { code: 1, stdout: '', stderr: detail };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
