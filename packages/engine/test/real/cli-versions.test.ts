// probe 的命令行只读版本，不带升级。官方最新的解析在 shared，这里钉 argv。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CliToolReadingSave, runCliVersionsJob } from '../../src/jobs/cli-versions.ts';
import { cliProbeArgv, cliVersionsJob } from '../../src/real/cli-versions.ts';

afterEach(() => vi.unstubAllGlobals());

describe('reclaude artifact 真接线', () => {
  const sha256 = '0c769d6b70da513cef6860e4788e97183e35782ef8d9189be453fe3d551c95fa';
  const manifest = { version: 'v1.5.0', binaries: { 'linux-amd64': { sha256 } } };
  const metadata = { source: 'reclaude-binary-sha256', platform: 'linux-amd64', sha256 };
  it('每轮 latest 和两个用户共用一份官方请求，传给帮手的仍只有固定 argv', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest)));
    vi.stubGlobal('fetch', fetcher);
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify(metadata),
      stderr: '',
      timedOut: false,
    }));
    const factory = cliVersionsJob({ db: {} as never, run, log: () => {} });
    const job = factory();
    expect(await job.fetchLatest('reclaude')).toEqual({ latest: '1.5.0', versions: null });
    for (const user of ['pilot', 'fleet-agent-carpool']) {
      expect(await job.probeUser(user, 'reclaude')).toEqual({ version: '1.5.0' });
      expect(run).toHaveBeenCalledWith(cliProbeArgv({ user, tool: 'reclaude' }), 25_000);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://dl.reclaude.ai/stable.json', expect.any(Object));
    await factory().probeUser('pilot', 'reclaude');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('官方读取失败仍复用失败，保留 unknown；下一轮才重试', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('HTTPS timeout');
    });
    vi.stubGlobal('fetch', fetcher);
    const job = cliVersionsJob({
      db: {} as never,
      run: async () => ({ code: 0, stdout: JSON.stringify(metadata), stderr: '', timedOut: false }),
      log: () => {},
    })();
    expect(await job.fetchLatest('reclaude')).toEqual({ error: 'HTTPS timeout' });
    for (const user of ['pilot', 'fleet-agent-carpool'])
      expect(await job.probeUser(user, 'reclaude')).toEqual({
        error: '来源不明：reclaude 官方 artifact 没读成：HTTPS timeout',
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    JSON.stringify({ ...metadata, sha256: '1'.repeat(64) }),
    '2.1.308 (Claude Code)',
    'Syncing config...\nreclaude 1.5.0',
  ])('旧输出或不匹配的安装文件不能成为成功：%s', async (stdout) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(manifest)));
    const job = cliVersionsJob({
      db: {} as never,
      run: async () => ({ code: 0, stdout, stderr: '', timedOut: false }),
      log: () => {},
    })();
    expect(await job.probeUser('pilot', 'reclaude')).toHaveProperty('error');
  });

  it.each(['missing-sha256', 'mismatch', 'fetch-failed'])(
    '官方摘要缺失/不符/读取失败仍存 NULL 和原因、整轮 partial：%s',
    async (failure) => {
      vi.stubGlobal('fetch', async () => {
        if (failure === 'fetch-failed') throw new Error('HTTPS timeout');
        return new Response(
          JSON.stringify(
            failure === 'missing-sha256' ? { version: 'v1.5.0', binaries: { 'linux-amd64': {} } } : manifest,
          ),
        );
      });
      const deps = cliVersionsJob({
        db: {} as never,
        run: async () => ({
          code: 0,
          stdout: JSON.stringify(failure === 'mismatch' ? { ...metadata, sha256: '1'.repeat(64) } : metadata),
          stderr: '',
          timedOut: false,
        }),
        log: () => {},
      })();
      const saved: CliToolReadingSave[] = [];
      const result = await runCliVersionsJob({
        ...deps,
        fetchLatest: (tool) =>
          tool === 'reclaude' ? deps.fetchLatest(tool) : Promise.resolve({ latest: '1.0.0', versions: null }),
        save: async (row) => {
          saved.push(row);
        },
        runs: { start: async () => 1, finish: async () => {} },
      });
      expect(result.outcome).toBe('partial');
      const reclaude = saved.filter((row) => row.tool === 'reclaude');
      expect(reclaude).toHaveLength(2);
      for (const row of reclaude) {
        expect(row.installedVersion).toBeNull();
        expect(row.installedError).toContain('来源不明');
      }
    },
  );
});

describe('命令行工具版本的探测命令', () => {
  it('只跑 probe，参数是写死的工具名，没有安装或升级', () => {
    const user = cliProbeArgv({ user: 'pilot', tool: 'grok' });
    const npm = cliProbeArgv({ npmTool: 'pi' });
    expect(user).toEqual(['sudo', '-n', 'fleet-agent-scope', 'probe', '--user', 'pilot', '--', 'grok']);
    expect(npm).toEqual(['sudo', '-n', 'fleet-agent-scope', 'probe', '--npm', '--', 'pi']);
    for (const argv of [user, npm]) {
      expect(argv.join(' ')).not.toMatch(/update|upgrade|install/i);
    }
  });

  it('reclaude 只经 probe 白名单，argv 里没有 --version、run、org、login 等：不在引擎这边启动它', () => {
    const argv = cliProbeArgv({ user: 'pilot', tool: 'reclaude' });
    expect(argv).toEqual(['sudo', '-n', 'fleet-agent-scope', 'probe', '--user', 'pilot', '--', 'reclaude']);
    expect(argv.join(' ')).not.toMatch(/--version|\brun\b|org|login|logout|update|install/i);
  });

  it('reclaude 来源不明（非 0 + 原因）原样成为读不到的原因，不变成版本', async () => {
    const job = cliVersionsJob({
      db: {} as never,
      run: async () => ({
        code: 1,
        stdout: '',
        stderr: 'fleet-agent-scope：reclaude 的在用版本来源不明：没有只读的自身版本入口',
        timedOut: false,
      }),
      log: () => {},
    })();
    const got = await job.probeUser('pilot', 'reclaude');
    expect(got).toEqual({ error: 'fleet-agent-scope：reclaude 的在用版本来源不明：没有只读的自身版本入口' });
  });

  it('接线把探测失败原样交给任务，不改成 0', async () => {
    const argv: string[][] = [];
    const job = cliVersionsJob({
      db: {} as never,
      run: async (args) => {
        argv.push([...args]);
        return { code: 1, stdout: '', stderr: '找不到命令', timedOut: false };
      },
      log: () => {},
    })();
    const got = await job.probeUser('pilot', 'claude');
    expect(got).toEqual({ error: '找不到命令' });
    expect(argv[0]).toContain('probe');
    expect(argv[0]).not.toContain('run');
  });
});
