// 装没装：看可执行文件在不在 PATH 或家目录的 .local/bin 里；两个平台的路径表逐列对得上。
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findBin, installedAgents } from '../src/detect.ts';
import { RETIRE_FILES, RETIRE_SKILL_DIRS, RULES_TARGETS, SKILL_TARGETS, slashed } from '../src/targets.ts';
import { cleanup, IS_ROOT, PLATFORM, tempDir } from './helpers.ts';

afterEach(cleanup);

describe('装没装', () => {
  it('PATH 里有：算装了；家目录 .local/bin 里有：也算', () => {
    const home = tempDir('home');
    const bin = tempDir('bin');
    const exe = (dir: string, name: string): void => {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, PLATFORM === 'win32' ? `${name}.cmd` : name);
      writeFileSync(file, '');
      chmodSync(file, 0o755);
    };
    exe(bin, 'codex');
    exe(join(home, '.local', 'bin'), 'reclaude');
    const found = installedAgents({
      env: { PATH: bin, PATHEXT: '.COM;.EXE;.CMD' },
      platform: PLATFORM,
      home,
    });
    expect([...found].sort()).toEqual(['claude', 'codex']);
  });

  it('PATH 是空的、家里也没有：一家都没装', () => {
    expect(installedAgents({ env: {}, platform: PLATFORM, home: tempDir('home') }).size).toBe(0);
  });

  it.skipIf(PLATFORM === 'win32' || IS_ROOT)('Linux 上没有执行位的不算', () => {
    const bin = tempDir('bin');
    writeFileSync(join(bin, 'codex'), '');
    chmodSync(join(bin, 'codex'), 0o644);
    expect(
      findBin('codex', { env: { PATH: bin }, platform: 'linux', home: tempDir('home') }),
    ).toBeUndefined();
  });

  it.skipIf(PLATFORM !== 'win32')('Windows 上按 PATHEXT 找（codex.cmd 算 codex）', () => {
    const bin = tempDir('bin');
    writeFileSync(join(bin, 'codex.cmd'), '');
    const found = findBin('codex', {
      env: { PATH: bin, PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      home: tempDir('h'),
    });
    expect(found?.toLowerCase()).toBe(join(bin, 'codex.cmd').toLowerCase());
  });
});

describe('两个平台的路径表', () => {
  const places = [
    ...RULES_TARGETS.flatMap((t) => [t.file, ...(t.shadowedBy ?? [])]),
    ...SKILL_TARGETS.map((t) => t.dir),
    ...RETIRE_SKILL_DIRS,
    ...RETIRE_FILES,
  ];

  it('Windows 一列用 \\、Linux 一列用 /，都是相对家目录', () => {
    for (const p of places) {
      expect(p.win32).not.toContain('/');
      expect(p.linux).not.toContain('\\');
      expect(p.win32.startsWith('\\') || p.linux.startsWith('/')).toBe(false);
    }
  });

  it('除了 Devin 自己的目录（Windows 在 AppData\\Roaming、Linux 在 ~/.config），两列指的是同一处', () => {
    const differ = places.filter((p) => slashed(p.win32) !== p.linux).map((p) => p.linux);
    expect(differ).toEqual(['.config/devin/skills']);
  });

  it('每一处全局文件、skill 目录都写了谁读', () => {
    for (const t of [...RULES_TARGETS, ...SKILL_TARGETS]) expect(t.readers.length).toBeGreaterThan(0);
  });
});
