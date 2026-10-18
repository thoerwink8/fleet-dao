import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ProcResult, runUpgrade, type UpgradeIo } from '../src/cli-upgrade.ts';
import { installGoTar } from '../src/cli-upgrade-go.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
const spec = { id: 'go', name: 'Go', via: 'tar' as const, version: '1.25.1', bin: '/usr/local/bin/go' };
const success = (stdout = ''): ProcResult => ({ code: 0, stdout, stderr: '' });
async function harness(failure = '', old = true) {
  const root = await mkdtemp(join(tmpdir(), 'fleet-go-'));
  roots.push(root);
  const entry = join(root, '/usr/local/bin/go');
  await mkdir(dirname(entry), { recursive: true });
  if (old) await writeFile(entry, 'old-go');
  const bytes = Buffer.from('official archive fixture');
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (failure === 'download') return new Response('no', { status: 503 });
    if (String(url).includes('mode=json'))
      return Response.json([
        {
          version: 'go1.25.1',
          files: [
            {
              filename: 'go1.25.1.linux-amd64.tar.gz',
              version: 'go1.25.1',
              os: 'linux',
              arch: 'amd64',
              kind: 'archive',
              size: bytes.length,
              sha256:
                failure === 'checksum' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
            },
          ],
        },
      ]);
    return new Response(bytes);
  });
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === entry && !(await readFile(entry, 'utf8').catch(() => '')).includes('new-go'))
      return success('go version go1.24.0 linux/amd64');
    if (cmd === 'tar') {
      if (args[0] === '-tzf')
        return success(failure === 'path' ? 'go/../escape\ngo/bin/go\n' : 'go/\ngo/bin/go\n');
      if (args[0] === '-tvzf')
        return success(failure === 'link' ? 'lrwxrwxrwx link' : 'drwxr-xr-x go/\n-rwxr-xr-x go/bin/go\n');
      if (failure === 'extract') return { code: 1, stdout: '', stderr: 'bad archive' };
      const stage = args[args.indexOf('--directory') + 1] ?? '';
      await mkdir(join(stage, 'go/bin'), { recursive: true });
      await writeFile(join(stage, 'go/bin/go'), 'new-go');
      return success();
    }
    if (cmd === '/usr/bin/env')
      return failure === 'path-check'
        ? success('/usr/bin/go\ngo version go1.24.0 linux/amd64')
        : success(`${entry}\ngo version go1.25.1 linux/amd64`);
    return failure === 'execute'
      ? { code: 126, stdout: '', stderr: 'exec format error' }
      : success('go version go1.25.1 linux/amd64');
  });
  return {
    root,
    entry,
    fetcher,
    exec,
    run: () =>
      installGoTar(spec, { root, fetch: fetcher as typeof fetch, exec, platform: 'linux', arch: 'x64' }),
  };
}
describe('固定Go安装事务', () => {
  it.each([false, true])('初装或升级完整新树，实际入口和PATH核验通过：旧版=%s', async (old) => {
    const h = await harness('', old);
    expect((await h.run()).code).toBe(0);
    expect(await readFile(h.entry, 'utf8')).toBe('new-go');
    h.fetcher.mockClear();
    expect((await h.run()).stdout).toContain('已是');
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it.each(['download', 'checksum', 'path', 'link', 'extract', 'execute', 'path-check'])(
    '%s失败保持旧入口可用',
    async (failure) => {
      const h = await harness(failure);
      expect((await h.run()).code).toBe(1);
      expect(await readFile(h.entry, 'utf8')).toBe('old-go');
    },
  );
  it('优先PATH已有旧Go时明确失败，不替换任何入口', async () => {
    const h = await harness();
    const other = join(h.root, '/usr/local/go/bin/go');
    await mkdir(dirname(other), { recursive: true });
    await writeFile(other, 'other-go');
    expect((await h.run()).stderr).toContain('遮住');
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(await readFile(other, 'utf8')).toBe('other-go');
  });
  it('下载后出现会话时保留旧入口', async () => {
    const h = await harness();
    const result = await installGoTar(spec, {
      root: h.root,
      exec: h.exec,
      fetch: h.fetcher as typeof fetch,
      platform: 'linux',
      arch: 'x64',
      sessions: async () => 1,
    });
    expect(result.stderr).toContain('出现会话');
    expect(await readFile(h.entry, 'utf8')).toBe('old-go');
  });
  it('未知平台不下载', async () => {
    const h = await harness();
    const result = await installGoTar(spec, {
      root: h.root,
      exec: h.exec,
      fetch: h.fetcher as typeof fetch,
      platform: 'win32',
      arch: 'x64',
    });
    expect(result.stderr).toContain('不支持');
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});

describe('切换前拒绝不会锁死固定工具升级', () => {
  it.each(['new-session', 'unknown'])('%s拒绝后下一空闲轮可以重试', async (reason) => {
    const h = await harness();
    let interrupted = true;
    const sessions = async () => {
      if (!interrupted) return 0;
      if (reason === 'unknown') throw new Error('drain read failed');
      return 1;
    };
    const io: UpgradeIo = {
      now: () => new Date(),
      sessions: () => 0,
      versionOf: async () =>
        success(
          (await readFile(h.entry, 'utf8')).includes('new-go')
            ? 'go version go1.25.1 linux/amd64'
            : 'go version go1.24.0 linux/amd64',
        ),
      installTar: (tool) =>
        installGoTar(tool, {
          root: h.root,
          exec: h.exec,
          fetch: h.fetcher as typeof fetch,
          platform: 'linux',
          arch: 'x64',
          sessions,
        }),
      npmVersion: async () => '',
      npmPublishedAt: async () => null,
      npmInstall: async () => success(),
      npmUninstall: async () => success(),
      grokLatestVersion: async () => null,
      smoke: async () => success(),
      installSelf: async () => success(),
      backup: async () => null,
      restore: async () => success(),
    };
    const first = await runUpgrade({ tools: [spec], previous: null, io, why: 'idle', requestAt: null });
    expect(first.tools.go?.outcome).toBe('refused');
    expect(first.tools.go?.failure).toBeUndefined();
    expect(await readFile(h.entry, 'utf8')).toBe('old-go');
    interrupted = false;
    const second = await runUpgrade({ tools: [spec], previous: first, io, why: 'idle', requestAt: null });
    expect(second.tools.go?.outcome).toBe('ok');
    expect(second.tools.go?.failure).toBeUndefined();
    expect(await readFile(h.entry, 'utf8')).toBe('new-go');
  });
});
