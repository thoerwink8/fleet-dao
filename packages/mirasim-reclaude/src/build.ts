import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PreparedBinary } from './migrate.ts';

export function runtimeSourceHash(repo: string): string {
  const dir = join(repo, 'packages', 'mirasim-reclaude', 'launcher');
  const names = readdirSync(dir)
    .filter((n) => n === 'go.mod' || (n.endsWith('.go') && !n.endsWith('_test.go')))
    .sort();
  if (!names.includes('go.mod') || names.length < 2) throw new Error('启动器源码不完整，不能迁移');
  const hash = createHash('sha256');
  for (const name of names)
    hash
      .update(`${name}\0`)
      .update(readFileSync(join(dir, name), 'utf8').replaceAll('\r\n', '\n'))
      .update('\0');
  return hash.digest('hex');
}

export function artifactName(platform: string, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch;
  if (!['windows-amd64', 'darwin-amd64', 'darwin-arm64', 'linux-amd64'].includes(`${os}-${cpu}`))
    throw new Error('平台或架构还没有验证过的构建');
  return `mirasim-launcher-${os}-${cpu}`;
}

export async function prepareBinary(input: PreparedBinary): Promise<string> {
  artifactName(input.platform, input.arch);
  const dir = join(input.repo, 'packages', 'mirasim-reclaude', 'launcher');
  const staged = `${input.destination}.${randomUUID()}.new`;
  const probe = spawnSync('go', ['version'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  if (probe.status === 0) {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: input.repo,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    try {
      execFileSync(
        'go',
        [
          'build',
          '-trimpath',
          '-ldflags',
          `-s -w -X main.sourceCommit=${commit} -X main.sourceHash=${input.sourceHash}`,
          '-o',
          staged,
          '.',
        ],
        {
          cwd: dir,
          timeout: 180_000,
          windowsHide: true,
          env: {
            ...process.env,
            CGO_ENABLED: '0',
            GOOS: input.platform === 'win32' ? 'windows' : input.platform,
            GOARCH: input.arch === 'x64' ? 'amd64' : input.arch,
          },
          stdio: 'pipe',
        },
      );
    } catch {
      throw new Error('启动器编译失败，旧接入未替换');
    }
  } else {
    const repo = 'thoerwink8/fleet-dao';
    let runs: { workflow_runs?: { id: number; head_sha: string; event: string }[] };
    try {
      runs = JSON.parse(
        execFileSync(
          'gh',
          [
            'api',
            `repos/${repo}/actions/workflows/mirasim-launcher.yml/runs?branch=main&status=success&per_page=10`,
          ],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true },
        ),
      );
    } catch {
      throw new Error('本机没有 Go，且读不到 GitHub 的已验证构建；请确认 gh 登录状态');
    }
    const download = join(dirname(input.destination), `download-${randomUUID()}`);
    mkdirSync(download, { recursive: true, mode: 0o700 });
    let found = false;
    for (const run of runs.workflow_runs ?? []) {
      if (run.event !== 'push' && run.event !== 'workflow_dispatch') continue;
      const out = join(download, String(run.id));
      try {
        execFileSync(
          'gh',
          [
            'run',
            'download',
            String(run.id),
            '--repo',
            repo,
            '--name',
            artifactName(input.platform, input.arch),
            '--dir',
            out,
          ],
          { timeout: 60_000, windowsHide: true, stdio: 'pipe' },
        );
        const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
        const file = input.platform === 'win32' ? 'mirasim-reclaude.exe' : 'mirasim-reclaude';
        if (
          manifest.sourceHash !== input.sourceHash ||
          manifest.commit !== run.head_sha ||
          manifest.file !== file ||
          basename(manifest.file) !== manifest.file
        )
          continue;
        const binary = join(out, file);
        const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
        if (digest !== manifest.sha256) throw new Error('构建文件校验失败');
        copyFileSync(binary, staged);
        found = true;
        break;
      } catch (error) {
        if (error instanceof Error && error.message === '构建文件校验失败') throw error;
      }
    }
    if (!found) throw new Error('没有与当前源码匹配的已验证构建，旧接入未替换');
  }
  chmodSync(staged, 0o755);
  renameSync(staged, input.destination);
  return input.destination;
}
