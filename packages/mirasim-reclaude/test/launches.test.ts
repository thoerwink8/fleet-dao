import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from '@fleet-dao/adapters/testing';
import { describe, expect, it } from 'vitest';
import { checkExitCode, launchOverrides, overrideLines } from '../src/launches.ts';
import { runChild } from './child.ts';

const SID_BARE = 'aaaaaaaa-1111-4111-8111-111111111111';
const SID_TOOL = 'bbbbbbbb-2222-4222-8222-222222222222';
const SID_OTHER = 'cccccccc-3333-4333-8333-333333333333';
const SID_ARGS = 'dddddddd-4444-4444-8444-444444444444';

function homeWithOverrides(launches: Record<string, unknown>): string {
  const home = tempDir();
  const dir = join(home, '.mirasim', 'plugin-index');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ws.json'), JSON.stringify({ routes: {}, launches }));
  writeFileSync(join(dir, 'ws.queue.json'), '{broken but ignored');
  writeFileSync(
    join(home, '.mirasim', 'setting.json'),
    JSON.stringify({ agentLaunch: { claude: { command: 'claude' } } }),
  );
  return home;
}

const sample = {
  [`claude:${SID_BARE}`]: { command: '/usr/local/bin/claude' },
  [`claude:${SID_TOOL}`]: {
    command: '/h/.fleet-dao/mirasim-reclaude/releases/x/mirasim-reclaude',
    args: '--x',
  },
  [`claude:${SID_OTHER}`]: { command: '/opt/my-wrapper' },
  [`claude:${SID_ARGS}`]: { args: '--verbose' },
  'claude:empty-entry': { command: '  ', args: '' },
  'codex:not-claude': { command: 'claude' },
};

describe('单会话启动命令覆盖（plugin-index 的 launches）', () => {
  it('列出并分类：本工具启动器 / 裸 claude＝绕过 reclaude / 其他 / 只改参数；空项和非 claude 不算', () => {
    const list = launchOverrides(homeWithOverrides(sample));
    const kinds = Object.fromEntries(list.map((o) => [o.sid, o.kind]));
    expect(kinds).toEqual({
      [SID_BARE]: 'bare',
      [SID_TOOL]: 'launcher',
      [SID_OTHER]: 'other',
      [SID_ARGS]: 'args-only',
    });
  });

  it('输出只打会话 ID 前 8 位和命令文件名，不打参数；裸 claude 标红计数', () => {
    const { lines, bare } = overrideLines(launchOverrides(homeWithOverrides(sample)));
    expect(bare).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain(`${SID_BARE.slice(0, 8)}`);
    expect(text).not.toContain(SID_BARE);
    expect(text).toMatch(/裸 claude/);
    expect(text).not.toContain('--verbose');
    expect(overrideLines([]).lines.join()).toContain('无');
  });

  it('索引读不到或 launches 格式不认识：明确失败，不当成没有覆盖', () => {
    const home = homeWithOverrides({});
    writeFileSync(join(home, '.mirasim', 'plugin-index', 'ws.json'), '{broken');
    expect(() => launchOverrides(home)).toThrow(/索引/);
    writeFileSync(join(home, '.mirasim', 'plugin-index', 'ws.json'), JSON.stringify({ launches: [] }));
    expect(() => launchOverrides(home)).toThrow(/launches/);
  });

  it('--check：当前新版但有裸 claude 覆盖退出 75，其余照原退出码', () => {
    expect(checkExitCode('current', 0)).toBe(0);
    expect(checkExitCode('current', 1)).toBe(75);
    expect(checkExitCode('waiting', 0)).toBe(75);
    expect(checkExitCode('waiting', 2)).toBe(75);
  });

  it('命令行 --check 把覆盖列出来', () => {
    const home = homeWithOverrides(sample);
    const bin = resolve(import.meta.dirname, '..', 'bin', 'migrate');
    const r = runChild(process.execPath, [bin, '--check', '--home', home]);
    expect(r.status).toBe(75);
    expect(r.stdout).toContain(SID_BARE.slice(0, 8));
    expect(r.stdout).toMatch(/裸 claude/);
  });
});
