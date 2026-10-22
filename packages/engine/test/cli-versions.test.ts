// 命令行工具版本这一轮：读不到记原因、两个用户分开存、库写失败整轮没跑成。不升级。
import { describe, expect, it } from 'vitest';
import {
  CLI_VERSIONS_JOB,
  type CliToolReadingSave,
  type CliVersionsJobDeps,
  runCliVersionsJob,
} from '../src/jobs/cli-versions.ts';

const NOW = new Date('2026-10-12T14:11:00.000Z');

const STDOUT: Record<string, string> = {
  claude: '2.1.282 (Claude Code)\n',
  codex: 'codex-cli 0.156.1\n',
  grok: 'grok 1.0.41 (abc)\n',
  'cursor-agent': '2026.09.23-86fc751\n',
  reclaude: 'reclaude 1.4.0\n',
  'mirasim-server': '0.0.355\n',
};

function harness(over: Partial<CliVersionsJobDeps> = {}) {
  const saved: CliToolReadingSave[] = [];
  const probes: { user: string; tool: string }[] = [];
  const fetches: string[] = [];
  const finished: { outcome: string; why?: string }[] = [];
  const deps: CliVersionsJobDeps = {
    probeUser: async (user, tool) => {
      probes.push({ user, tool });
      if (user === 'fleet-agent-carpool' && tool === 'claude') return { error: '退出码 127（找不到命令）' };
      return { stdout: STDOUT[tool] ?? '' };
    },
    probeNpm: async (tool) => {
      if (tool === 'pi') return { stdout: '{"dependencies":{}}' };
      if (tool === 'kimi-code') {
        return { stdout: '{"dependencies":{"@moonshot-ai/kimi-code":{"version":"2.1.1"}}}' };
      }
      return { stdout: '{"dependencies":{"@deepseek-ai/dsh":{"version":"0.1.5"}}}' };
    },
    fetchLatest: async (tool) => {
      fetches.push(tool);
      if (tool === 'reclaude') return { latest: '1.4.1', versions: null };
      if (tool === 'grok') return { latest: '1.0.50', versions: ['1.0.41', '1.0.50'] };
      return { latest: '9.9.9', versions: ['9.9.9'] };
    },
    save: async (row) => {
      saved.push(row);
    },
    runs: {
      start: async () => 7,
      finish: async (_id, result) => {
        finished.push(result);
      },
    },
    now: () => NOW,
    log: () => {},
    ...over,
  };
  return { deps, saved, probes, fetches, finished };
}

describe('命令行工具版本这一轮', () => {
  it('【故意造出的失败】读不到记原因，不写成 0 或 ok；两个用户分开存；reclaude 的版本列表保持 null', async () => {
    const h = harness();
    const result = await runCliVersionsJob(h.deps);
    expect(result.outcome).toBe('partial');
    const carClaude = h.saved.find((r) => r.owner === 'fleet-agent-carpool' && r.tool === 'claude');
    const pilotClaude = h.saved.find((r) => r.owner === 'pilot' && r.tool === 'claude');
    expect(carClaude?.installedVersion).toBeNull();
    expect(carClaude?.installedError).toBe('退出码 127（找不到命令）');
    expect(carClaude?.installedError).not.toBe('0');
    expect(carClaude?.installedError).not.toBe('ok');
    expect(pilotClaude?.installedVersion).toBe('2.1.282');
    expect(pilotClaude?.installedError).toBeNull();
    expect(h.saved.filter((r) => r.tool === 'claude').map((r) => r.owner)).toEqual([
      'fleet-agent-carpool',
      'pilot',
    ]);
    const reclaude = h.saved.find((r) => r.tool === 'reclaude');
    expect(reclaude?.releaseVersions).toBeNull();
    expect(reclaude?.latestVersion).toBe('1.4.1');
    expect(h.saved.every((r) => !('status' in r) && !('behind' in r))).toBe(true);
    const pi = h.saved.find((r) => r.scope === 'npm' && r.tool === 'pi');
    expect(pi?.installedVersion).toBeNull();
    expect(pi?.installedError).toContain('全局 npm 里没有');
    expect(h.fetches.filter((t) => t === 'grok')).toEqual(['grok']);
    // pilot 上从没装过 Grok / Cursor / Mirasim：不探，探了只会永远失败
    expect(h.probes.filter((p) => p.tool === 'grok').map((p) => p.user)).toEqual(['fleet-agent-carpool']);
    expect(h.probes.filter((p) => p.user === 'pilot').map((p) => p.tool)).toEqual([
      'claude',
      'codex',
      'reclaude',
    ]);
  });

  it('【故意造出的失败】reclaude 只出 Claude Code 版本、设备已解绑：不存成 reclaude 版本，保留各自原因，这一轮 partial', async () => {
    const outputs: Record<string, { stdout: string } | { error: string }> = {
      'fleet-agent-carpool': { stdout: 'Syncing config...\n2.1.308 (Claude Code)\n' },
      pilot: { error: 'Syncing config... login no longer valid：此设备已被解绑' },
    };
    const h = harness({
      probeUser: async (user, tool) => {
        if (tool === 'reclaude') return outputs[user] ?? { error: '没有输出' };
        return { stdout: STDOUT[tool] ?? '' };
      },
    });
    const result = await runCliVersionsJob(h.deps);
    expect(result.outcome).toBe('partial');
    const car = h.saved.find((r) => r.owner === 'fleet-agent-carpool' && r.tool === 'reclaude');
    expect(car?.installedVersion).toBeNull();
    expect(car?.installedError).toContain('认不出版本');
    expect(car?.installedError).toContain('Claude Code');
    const pilot = h.saved.find((r) => r.owner === 'pilot' && r.tool === 'reclaude');
    expect(pilot?.installedVersion).toBeNull();
    expect(pilot?.installedError).toContain('此设备已被解绑');
    // 其它工具照常读成
    expect(h.saved.find((r) => r.owner === 'pilot' && r.tool === 'claude')?.installedVersion).toBe('2.1.282');
    for (const row of h.saved)
      expect(Boolean(row.installedVersion) !== Boolean(row.installedError)).toBe(true);
    expect(result.outcome === 'partial' && result.why).toContain('reclaude');
  });

  it('reclaude 带 Syncing 前缀但有自己的版本行：照常读成，且仍恰好一个有效', async () => {
    const h = harness({
      probeUser: async (_user, tool) => ({
        stdout: tool === 'reclaude' ? 'Syncing config...\nreclaude 1.5.0\n' : (STDOUT[tool] ?? ''),
      }),
    });
    await runCliVersionsJob(h.deps);
    const rows = h.saved.filter((r) => r.tool === 'reclaude');
    expect(rows.map((r) => r.installedVersion)).toEqual(['1.5.0', '1.5.0']);
    expect(rows.every((r) => r.installedError === null)).toBe(true);
  });

  it('【故意造出的失败】库写不进：这一轮记 failed 再抛，不当成跑成', async () => {
    const h = harness({
      save: async () => {
        throw new Error('库断了');
      },
    });
    await expect(runCliVersionsJob(h.deps)).rejects.toThrow('库断了');
    expect(h.finished[0]?.outcome).toBe('failed');
    expect(h.finished[0]?.why).toContain('库断了');
  });

  it('登记的编号是 cli-versions，不拉单', () => {
    expect(CLI_VERSIONS_JOB.id).toBe('cli-versions');
    expect(CLI_VERSIONS_JOB).not.toHaveProperty('needsMaster');
  });
});
