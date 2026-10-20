import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installTemporalCli,
  type TemporalCliArtifact,
  temporalCliArtifact,
} from '../src/temporal-cli-install.ts';
import { prepareTemporalCli } from '../src/temporal-test-cli.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tarArchive(name: string, content: Uint8Array): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000755\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${content.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header[156] = 48;
  const body = Buffer.from(content);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

function fixture(content = Buffer.from('temporal-cli-fixture')) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-temporal-cli-install-'));
  roots.push(root);
  mkdirSync(join(root, 'deploy'));
  writeFileSync(join(root, 'deploy/france.sh'), 'TEMPORAL_CLI_VERSION=1.9.1\n');
  const home = join(root, 'home');
  const binary = tarArchive('temporal', content);
  const base = temporalCliArtifact(root, 'linux', 'x64');
  const artifact: TemporalCliArtifact = {
    ...base,
    sha256: createHash('sha256').update(binary).digest('hex'),
  };
  const probe = vi.fn(() => 'temporal version 1.9.1 (fixture)');
  return { root, home, binary, artifact, probe };
}

function options(
  fixtureValue: ReturnType<typeof fixture>,
  download: (url: string, path: string, signal: AbortSignal) => Promise<void>,
) {
  return {
    home: fixtureValue.home,
    artifact: fixtureValue.artifact,
    probe: fixtureValue.probe,
    download,
  };
}

describe('installTemporalCli', () => {
  it('按平台生成官方发布地址和固定校验和', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-temporal-cli-artifact-'));
    roots.push(root);
    mkdirSync(join(root, 'deploy'));
    writeFileSync(join(root, 'deploy/france.sh'), 'TEMPORAL_CLI_VERSION=1.9.1\n');
    expect(temporalCliArtifact(root, 'darwin', 'arm64')).toMatchObject({
      archive: 'temporal_cli_1.9.1_darwin_arm64.tar.gz',
      url: 'https://github.com/temporalio/cli/releases/download/v1.9.1/temporal_cli_1.9.1_darwin_arm64.tar.gz',
      sha256: '41e0425378fcb4fb5766340b97435e20fe47bbff2d7bf644ec2d51f7662b7c56',
    });
    expect(temporalCliArtifact(root, 'linux', 'arm64').target).toBe('linux_arm64');
    expect(temporalCliArtifact(root, 'win32', 'x64').executable).toBe('temporal.exe');
  });

  it('下载、校验、验版本后原子登记；已装好时不重下', async () => {
    const value = fixture();
    const download = vi.fn(async (_url: string, path: string) => writeFileSync(path, value.binary));
    const first = await installTemporalCli(value.root, options(value, download));
    expect(first.downloaded).toBe(true);
    expect(first.path).toContain('.fleet-dao/test-tools/temporal-cli/1.9.1/linux_amd64/temporal');
    expect(prepareTemporalCli(value.root, { home: value.home, env: {}, probe: value.probe })).toMatchObject({
      path: first.path,
      version: '1.9.1',
    });
    const second = await installTemporalCli(value.root, options(value, download));
    expect(second.downloaded).toBe(false);
    expect(download).toHaveBeenCalledOnce();
  });

  it('登记丢了但受管缓存里的程序核得过版本时只补登记，不重下', async () => {
    const value = fixture();
    const download = vi.fn(async (_url: string, path: string) => writeFileSync(path, value.binary));
    const first = await installTemporalCli(value.root, options(value, download));
    rmSync(join(value.home, '.fleet-dao', 'test-tools', 'temporal-cli-linux-x64.json'), { force: true });
    const again = await installTemporalCli(value.root, options(value, download));
    expect(again).toMatchObject({ downloaded: false, path: first.path });
    expect(download).toHaveBeenCalledOnce();
    expect(prepareTemporalCli(value.root, { home: value.home, env: {}, probe: value.probe }).path).toBe(
      first.path,
    );
  });

  it('重装失败不删掉受管缓存里已有的文件', async () => {
    const value = fixture();
    const target = join(value.home, '.fleet-dao', 'test-tools', 'temporal-cli', '1.9.1', 'linux_amd64');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'temporal'), 'old');
    const download = vi.fn(async (_url: string, path: string) => writeFileSync(path, Buffer.from('wrong')));
    await expect(
      installTemporalCli(value.root, {
        ...options(value, download),
        probe: () => 'temporal version 1.9.0',
        attempts: 1,
      }),
    ).rejects.toThrow('SHA-256 校验不符');
    expect(existsSync(join(target, 'temporal'))).toBe(true);
  });

  it('校验和不对时失败，不登记、不把半截归档当成已安装', async () => {
    const value = fixture();
    const download = vi.fn(async (_url: string, path: string) => writeFileSync(path, Buffer.from('wrong')));
    await expect(
      installTemporalCli(value.root, { ...options(value, download), attempts: 1 }),
    ).rejects.toThrow('SHA-256 校验不符');
    expect(readdirSync(join(value.home, '.fleet-dao'), { recursive: true })).not.toContain('temporal-cli');
  });

  it('单次超时后有界重试，重试用尽仍失败', async () => {
    const value = fixture();
    let calls = 0;
    const download = vi.fn(
      (_url: string, _path: string, signal: AbortSignal) =>
        new Promise<void>((_, reject) => {
          calls += 1;
          signal.addEventListener('abort', () => reject(new Error('ETIMEDOUT')), { once: true });
        }),
    );
    await expect(
      installTemporalCli(value.root, {
        ...options(value, download),
        attempts: 2,
        deadlineMs: 100,
        attemptTimeoutMs: 5,
      }),
    ).rejects.toThrow('下载重试用尽（2 次');
    expect(calls).toBe(2);
  });

  it('下载写入半截后失败会清理暂存，不发布目标文件', async () => {
    const value = fixture();
    const download = vi.fn(async (_url: string, path: string) => {
      writeFileSync(path, Buffer.from('partial'));
      throw new Error('connection reset');
    });
    await expect(
      installTemporalCli(value.root, { ...options(value, download), attempts: 1 }),
    ).rejects.toThrow('下载重试用尽');
    const managedParent = join(value.home, '.fleet-dao', 'test-tools', 'temporal-cli', '1.9.1');
    expect(existsSync(join(managedParent, 'linux_amd64'))).toBe(false);
    expect(readdirSync(managedParent)).toEqual([]);
  });

  it('归档校验通过但 CLI 版本不符时不登记', async () => {
    const value = fixture();
    const download = vi.fn(async (_url: string, path: string) => writeFileSync(path, value.binary));
    await expect(
      installTemporalCli(value.root, {
        ...options(value, download),
        probe: () => 'temporal version 1.9.0',
        attempts: 1,
      }),
    ).rejects.toThrow('版本须为 1.9.1');
    expect(readdirSync(join(value.home, '.fleet-dao', 'test-tools', 'temporal-cli', '1.9.1'))).toEqual([]);
  });
});
