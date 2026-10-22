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
  'mirasim-server': '0.0.355\n',
};

// fleet-agent-scope probe 对 reclaude 的真实回答：不执行它，报来源不明（deploy/test/agent-scope-probe.test.sh 钉住）
const RECLAUDE_UNKNOWN = 'fleet-agent-scope：reclaude 的在用版本来源不明：它没有只读的自身版本入口';

function harness(over: Partial<CliVersionsJobDeps> = {}) {
  const saved: CliToolReadingSave[] = [];
  const probes: { user: string; tool: string }[] = [];
  const fetches: string[] = [];
  const finished: { outcome: string; why?: string }[] = [];
  const deps: CliVersionsJobDeps = {
    probeUser: async (user, tool) => {
      probes.push({ user, tool });
      if (user === 'fleet-agent-carpool' && tool === 'claude') return { error: '退出码 127（找不到命令）' };
      if (tool === 'reclaude') return { error: RECLAUDE_UNKNOWN };
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
    // 官方 latest 不能顶成在用版本
    expect(reclaude?.installedVersion).toBeNull();
    expect(reclaude?.installedError).toBe(RECLAUDE_UNKNOWN);
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

  it('【故意造出的失败】reclaude 探测给出 Claude Code 版本、混合输出、设备已解绑：不存成 reclaude 版本，保留各自原因，这一轮 partial', async () => {
    const outputs: Record<string, { stdout: string } | { error: string }> = {
      'fleet-agent-carpool': { stdout: 'Syncing config...\nreclaude 1.5.0\n2.1.308 (Claude Code)\n' },
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
    expect(car?.installedError).toContain('来源不明');
    expect(car?.installedError).toContain('Claude Code');
    expect(car?.installedError).not.toContain('账号已恢复');
    const pilot = h.saved.find((r) => r.owner === 'pilot' && r.tool === 'reclaude');
    expect(pilot?.installedVersion).toBeNull();
    expect(pilot?.installedError).toContain('此设备已被解绑');
    // 其它工具照常读成
    expect(h.saved.find((r) => r.owner === 'pilot' && r.tool === 'claude')?.installedVersion).toBe('2.1.282');
    for (const row of h.saved)
      expect(Boolean(row.installedVersion) !== Boolean(row.installedError)).toBe(true);
    expect(result.outcome === 'partial' && result.why).toContain('reclaude');
  });

  it('reclaude 空输出、无版本也不当成功：记来源不明，不存空串或 0', async () => {
    for (const stdout of ['', 'Syncing config...\n']) {
      const h = harness({
        probeUser: async (_user, tool) => ({ stdout: tool === 'reclaude' ? stdout : (STDOUT[tool] ?? '') }),
      });
      const result = await runCliVersionsJob(h.deps);
      expect(result.outcome).toBe('partial');
      const rows = h.saved.filter((r) => r.tool === 'reclaude');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.installedVersion).toBeNull();
        expect(row.installedError).toContain('来源不明');
      }
    }
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
