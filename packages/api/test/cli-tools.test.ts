// 法国页「命令行工具」（#1971）：state.json 不在是还没升过；认不出是没查成，不拿空名单冒充查成了。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFranceCliTools } from '../src/cli-tools.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  dirs.push(path);
  return path;
}

describe('读命令行工具的升级结果', () => {
  it('文件不在：还没升过，不是没查成', async () => {
    const root = await dir();
    const got = await readFranceCliTools({ FLEET_CLI_UPGRADE_DIR: root });
    expect(got).toEqual({ state: 'ok', reason: null, checkedAt: null, why: null, tools: [] });
  });

  it('升完能读出版本和上次升级时间', async () => {
    const root = await dir();
    const checkedAt = '2026-10-12T12:00:00.000Z';
    const upgradedAt = '2026-10-12T12:00:01.000Z';
    await writeFile(
      join(root, 'state.json'),
      JSON.stringify({
        schema: 1,
        at: null,
        checkedAt,
        why: 'release',
        tools: {
          'claude-code': {
            name: 'Claude Code',
            version: '2.1.287',
            upgradedAt,
            channel: 'stable',
            outcome: 'ok',
            detail: '升到 2.1.287',
          },
        },
      }),
    );
    const got = await readFranceCliTools({ FLEET_CLI_UPGRADE_DIR: root });
    expect(got.state).toBe('ok');
    expect(got.checkedAt).toBe(checkedAt);
    expect(got.tools[0]).toMatchObject({
      name: 'Claude Code',
      version: '2.1.287',
      upgradedAt,
      outcome: 'ok',
    });
  });

  it('【故意造出的失败】不是 JSON：没查成，不假装还没升过', async () => {
    const root = await dir();
    await writeFile(join(root, 'state.json'), '不是');
    const got = await readFranceCliTools({ FLEET_CLI_UPGRADE_DIR: root });
    expect(got.state).toBe('unreadable');
    expect(got.reason).toContain('不是 JSON');
    expect(got.tools).toEqual([]);
  });
});
