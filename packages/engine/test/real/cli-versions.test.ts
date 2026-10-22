// probe 的命令行只读版本，不带升级。官方最新的解析在 shared，这里钉 argv。
import { describe, expect, it } from 'vitest';
import { cliProbeArgv, cliVersionsJob } from '../../src/real/cli-versions.ts';

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
