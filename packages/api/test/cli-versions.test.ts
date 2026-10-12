// 法国页命令行工具接口：没接上写没查成；接上了按读数现算，两个用户分开。
import { describe, expect, it } from 'vitest';
import { readCliTools } from '../src/cli-versions.ts';

const at = new Date('2026-10-12T14:00:00.000Z');

describe('GET /france/cli-tools', () => {
  it('【故意造出的失败】没接上：整段没查成，不回空列表当最新', async () => {
    const body = await readCliTools(undefined, at);
    expect(body).toEqual({
      state: 'unreadable',
      why: '这台后端没接上命令行工具版本的读取',
      asOf: at.toISOString(),
    });
  });

  it('两个用户分开，读不到的那一行不写成最新', async () => {
    const body = await readCliTools(
      {
        list: async () => [
          {
            scope: 'user',
            owner: 'fleet-agent-carpool',
            tool: 'codex',
            installedVersion: null,
            installedError: '退出码 127',
            latestVersion: '0.162.1',
            latestError: null,
            releaseVersions: ['0.156.1', '0.162.1'],
            checkedAt: at,
          },
          {
            scope: 'user',
            owner: 'pilot',
            tool: 'codex',
            installedVersion: '0.162.1',
            installedError: null,
            latestVersion: '0.162.1',
            latestError: null,
            releaseVersions: ['0.156.1', '0.162.1'],
            checkedAt: at,
          },
        ],
      },
      at,
    );
    expect(body.state).toBe('ok');
    if (body.state !== 'ok') return;
    const car = body.groups
      .find((g) => g.owner === 'fleet-agent-carpool')
      ?.rows.find((r) => r.tool === 'codex');
    const pilot = body.groups.find((g) => g.owner === 'pilot')?.rows.find((r) => r.tool === 'codex');
    expect(car?.status.label).toBe('读不到');
    expect(pilot?.status.label).toBe('最新');
  });
});
