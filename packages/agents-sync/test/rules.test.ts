// 通用段写进各家全局文件：查（checkRules）和写（applyRules）。
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { BEGIN, END } from '../src/block.ts';
import { exitCode, summary } from '../src/report.ts';
import { applyRules, checkRules } from '../src/sync.ts';
import {
  BLOCK,
  cleanup,
  ctxFor,
  expectKind,
  get,
  IS_ROOT,
  kinds,
  makeRepo,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-09-25T06:00:00Z');
const CLAUDE = '~/.claude/CLAUDE.md';
const CODEX = '~/.codex/AGENTS.md';

function setup(installed: Parameters<typeof ctxFor>[1] = ['claude', 'codex']) {
  const home = tempDir('home');
  const src = sources(makeRepo(null));
  const ctx = ctxFor(home, installed);
  const apply = () => applyRules(ctx, src, new Backups(home, PLATFORM, NOW));
  const check = () => checkRules(ctx, src);
  return { home, src, ctx, apply, check };
}

describe('缺失、漂移判红', () => {
  it('装了的那家没有文件：缺失，退出码 1', () => {
    const { check } = setup(['claude']);
    const lines = check();
    expectKind(lines, CLAUDE, 'missing');
    expect(exitCode(lines)).toBe(1);
  });

  it('文件在但没有受管块：缺失，并说出原文件几行', () => {
    const { home, check } = setup(['codex']);
    put(home, '.codex/AGENTS.md', '# 我自己的\n- 一\n- 二\n');
    const lines = check();
    expectKind(lines, CODEX, 'missing');
    expect(lines.find((l) => l.key === CODEX)?.text).toContain('文件在（3 行），里面没有受管块');
    expect(exitCode(lines)).toBe(1);
  });

  it('受管块被人改过：漂移，退出码 1', () => {
    const { home, check } = setup(['claude']);
    put(home, '.claude/CLAUDE.md', `${BLOCK.replace('说人话', '随便说')}\n`);
    const lines = check();
    expectKind(lines, CLAUDE, 'drift');
    expect(exitCode(lines)).toBe(1);
  });

  it('标记不成对：查判漂移，写不动它', () => {
    const { home, check, apply } = setup(['claude']);
    const broken = `前言\n${BEGIN}\n内容\n`;
    put(home, '.claude/CLAUDE.md', broken);
    expectKind(check(), CLAUDE, 'drift');
    expectKind(apply(), CLAUDE, 'failed');
    expect(get(home, '.claude/CLAUDE.md')).toBe(broken);
  });

  it('~/.codex/AGENTS.override.md 在：codex 读不到这份，判漂移', () => {
    const { home, check, apply } = setup(['codex']);
    put(home, '.codex/AGENTS.override.md', '# 别人的\n');
    expect(kinds(apply(), CODEX)).toEqual(['changed', 'failed']);
    expect(kinds(check(), CODEX)).toEqual(['drift']);
    expect(get(home, '.codex/AGENTS.override.md')).toBe('# 别人的\n');
  });
});

describe('没装的不算绿', () => {
  it('没装的逐项列成「没装，跳过」，不算进一致，也不影响退出码', () => {
    const { apply, check } = setup(['claude']);
    apply();
    const lines = check();
    expectKind(lines, CLAUDE, 'ok');
    for (const key of [
      CODEX,
      '~/.pi/agent/AGENTS.md',
      '~/.kimi-code/AGENTS.md',
      '~/.dsh/AGENTS.md',
      '~/.gemini/GEMINI.md',
    ]) {
      expectKind(lines, key, 'skip');
      expect(lines.find((l) => l.key === key)?.text).toContain('没装');
    }
    expect(lines.filter((l) => l.kind === 'ok')).toHaveLength(1);
    expect(exitCode(lines)).toBe(0);
    expect(summary(lines)).toContain('一致 1');
    expect(summary(lines)).toContain('没装或没东西（跳过）5');
  });

  it('没装的那家的文件一个字不写', () => {
    const { home, apply } = setup(['claude']);
    apply();
    expect(existsSync(join(home, '.codex'))).toBe(false);
    expect(existsSync(join(home, '.gemini'))).toBe(false);
  });

  it('只装了 Grok：照样写 ~/.claude/CLAUDE.md（Grok 借道读它）', () => {
    const { home, apply } = setup(['grok']);
    expectKind(apply(), CLAUDE, 'changed');
    expect(get(home, '.claude/CLAUDE.md')).toBe(`${BLOCK}\n`);
  });
});

describe('写', () => {
  it('没有文件：新建，内容就是受管块', () => {
    const { home, apply, check } = setup(['claude']);
    expectKind(apply(), CLAUDE, 'changed');
    expect(get(home, '.claude/CLAUDE.md')).toBe(`${BLOCK}\n`);
    expectKind(check(), CLAUDE, 'ok');
  });

  it('标记外的内容原样保留，只换受管的那一块', () => {
    const { home, apply, check } = setup(['claude']);
    const before = '# 我自己加的\n- 这一条是我的，不许动\n\n';
    const after = '\n\n## 也是我的\n- 结尾\n';
    put(home, '.claude/CLAUDE.md', `${before}${BEGIN}\n旧的通用段\n${END}${after}`);
    expectKind(apply(), CLAUDE, 'changed');
    expect(get(home, '.claude/CLAUDE.md')).toBe(`${before}${BLOCK}${after}`);
    expectKind(check(), CLAUDE, 'ok');
  });

  it('第一次接管（没有标记）：先整份备份，输出写明原文件几行、备份在哪，再整份换成受管块', () => {
    const { home, apply } = setup(['codex']);
    const original = '# 另一套规矩\n- 一\n- 二\n- 三\n';
    put(home, '.codex/AGENTS.md', original);
    const lines = apply();
    expectKind(lines, CODEX, 'changed');
    const backup = join(home, '.fleet-dao', 'backups', '2026-09-25T06-00-00-000Z', '.codex', 'AGENTS.md');
    expect(readFileSync(backup, 'utf8')).toBe(original);
    const text = lines.find((l) => l.key === CODEX)?.text ?? '';
    expect(text).toContain('原文件 4 行');
    expect(text).toContain(backup);
    expect(get(home, '.codex/AGENTS.md')).toBe(`${BLOCK}\n`);
  });

  it('已经有受管块：不再备份', () => {
    const { home, apply } = setup(['claude']);
    put(home, '.claude/CLAUDE.md', `${BEGIN}\n旧\n${END}\n`);
    apply();
    expect(existsSync(join(home, '.fleet-dao', 'backups'))).toBe(false);
  });

  it('第二遍零改动：一行「改了」都没有，文件一个字节不变', () => {
    const { home, apply } = setup(['claude', 'codex']);
    put(home, '.codex/AGENTS.md', '# 另一套\n');
    apply();
    const first = get(home, '.claude/CLAUDE.md') + get(home, '.codex/AGENTS.md');
    const again = apply();
    expect(again.filter((l) => l.kind === 'changed')).toEqual([]);
    expect(get(home, '.claude/CLAUDE.md') + get(home, '.codex/AGENTS.md')).toBe(first);
  });
});

describe('\\r 不算漂移', () => {
  it('同样的内容换成 \\r\\n 换行：查判一致，写也不动它', () => {
    const { home, apply, check } = setup(['claude']);
    const crlf = `前言\r\n${BLOCK.replaceAll('\n', '\r\n')}\r\n`;
    put(home, '.claude/CLAUDE.md', crlf);
    expectKind(check(), CLAUDE, 'ok');
    expectKind(apply(), CLAUDE, 'ok');
    expect(get(home, '.claude/CLAUDE.md')).toBe(crlf);
  });
});

describe('读不了、不是本脚本的文件', () => {
  it.skipIf(PLATFORM === 'win32' || IS_ROOT)(
    '文件读不了：没查成，退出码 2（不当成缺失，也不当成一致）',
    () => {
      const { home, check } = setup(['claude']);
      const file = put(home, '.claude/CLAUDE.md', `${BLOCK}\n`);
      chmodSync(file, 0o000);
      try {
        const lines = check();
        expectKind(lines, CLAUDE, 'unknown');
        expect(exitCode(lines)).toBe(2);
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );

  it('既有漂移又有没查成：退出码 1（红压过没查成，和装机脚本一样）', () => {
    expect(
      exitCode([
        { kind: 'drift', key: 'a', text: 'a' },
        { kind: 'unknown', key: 'b', text: 'b' },
      ]),
    ).toBe(1);
  });

  it.skipIf(PLATFORM === 'win32')('全局文件是个链接：不顺着链接去写它指的文件', () => {
    const { home, apply, check } = setup(['claude']);
    const elsewhere = put(tempDir('elsewhere'), 'global-CLAUDE.md', '# 别处的原件\n');
    put(home, '.claude/.keep', '');
    symlinkSync(elsewhere, join(home, '.claude', 'CLAUDE.md'));
    expectKind(apply(), CLAUDE, 'failed');
    expect(readFileSync(elsewhere, 'utf8')).toBe('# 别处的原件\n');
    expectKind(check(), CLAUDE, 'drift');
  });

  it.skipIf(PLATFORM === 'win32')('写过去的文件保留原来的权限位', () => {
    const { home, apply } = setup(['claude']);
    const file = put(home, '.claude/CLAUDE.md', `${BEGIN}\n旧\n${END}\n`);
    chmodSync(file, 0o600);
    apply();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
