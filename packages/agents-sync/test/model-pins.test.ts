// 设置里钉死的模型别名：~/.claude 和 reclaude 各账号的 settings.json，env 里的 ANTHROPIC_DEFAULT_*_MODEL 这几个算漂移，同步先备份再删。
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyModelPins, checkModelPins } from '../src/model-pins.ts';
import { exitCode } from '../src/report.ts';
import { cleanup, ctxFor, expectKind, get, getJson, PLATFORM, put, tempDir } from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-10-23T08:00:00Z');
const CLAUDE = '.claude/settings.json';
const ACC_A = '.rec/claude/accounts/50704/config/settings.json';
const ACC_B = '.rec/claude/accounts/51983/config/settings.json';
const keyOf = (rel: string): string => `~/${rel}#env`;

const PINNED = {
  env: {
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
  },
  permissions: { defaultMode: 'auto' },
};

function machine(files: Record<string, unknown>) {
  const home = tempDir('home');
  for (const [rel, body] of Object.entries(files))
    put(home, rel, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  const ctx = ctxFor(home, ['claude']);
  return {
    home,
    check: () => checkModelPins(ctx),
    apply: () => applyModelPins(ctx, new Backups(home, PLATFORM, NOW)),
  };
}

const textOf = (lines: { key: string; text: string }[], rel: string): string =>
  lines.find((l) => l.key === keyOf(rel))?.text ?? '';

describe('设置里钉死的模型别名', () => {
  it('有钉死的键：--check 报漂移，说清哪个文件、哪个键、钉的是什么', () => {
    const m = machine({ [CLAUDE]: PINNED });
    const lines = m.check();
    expectKind(lines, keyOf(CLAUDE), 'drift');
    const text = textOf(lines, CLAUDE);
    expect(text).toContain('~/.claude/settings.json');
    expect(text).toContain('env.ANTHROPIC_DEFAULT_HAIKU_MODEL 钉在 "claude-haiku-4-5-20251001"');
    expect(text).toContain('env.ANTHROPIC_DEFAULT_OPUS_MODEL 钉在 "claude-opus-4-8"');
    expect(exitCode(lines)).not.toBe(0);
  });

  it('没有这些键：报一致', () => {
    const m = machine({ [CLAUDE]: { env: { HTTPS_PROXY: 'x' } } });
    expectKind(m.check(), keyOf(CLAUDE), 'ok');
  });

  it('同步时先备份原文件再删这几个键，env 里别的、文件里别的都不动', () => {
    const m = machine({ [CLAUDE]: PINNED });
    const lines = m.apply();
    expectKind(lines, keyOf(CLAUDE), 'changed');
    const text = textOf(lines, CLAUDE);
    expect(text).toContain('删了 env.ANTHROPIC_DEFAULT_OPUS_MODEL 钉在 "claude-opus-4-8"');
    expect(text).toContain('env.ANTHROPIC_DEFAULT_HAIKU_MODEL 钉在 "claude-haiku-4-5-20251001"');
    expect(text).toContain('原文件备份在');
    expect(getJson(m.home, CLAUDE)).toEqual({
      env: { HTTPS_PROXY: 'http://127.0.0.1:9' },
      permissions: { defaultMode: 'auto' },
    });
    const root = join(m.home, '.fleet-dao', 'backups');
    const [stamp] = readdirSync(root);
    expect(getJson(join(root, stamp as string), CLAUDE)).toEqual(PINNED);
    expectKind(m.check(), keyOf(CLAUDE), 'ok');
  });

  it('reclaude 的两个账号目录都扫到、都清掉', () => {
    const m = machine({
      [ACC_A]: PINNED,
      [ACC_B]: { env: { ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5' } },
    });
    const before = m.check();
    expectKind(before, keyOf(ACC_A), 'drift');
    expectKind(before, keyOf(ACC_B), 'drift');
    expect(textOf(before, ACC_B)).toContain('env.ANTHROPIC_SMALL_FAST_MODEL 钉在 "claude-haiku-4-5"');
    const after = m.apply();
    expectKind(after, keyOf(ACC_A), 'changed');
    expectKind(after, keyOf(ACC_B), 'changed');
    expect(getJson(m.home, ACC_B)).toEqual({ env: {} });
    expect(exitCode(m.check())).toBe(0);
  });

  it('读不了、不是 JSON 的那份报没查成，不动它、接着扫别的', () => {
    const home = tempDir('home');
    mkdirSync(join(home, ...CLAUDE.split('/')), { recursive: true }); // 设置文件的位置是个目录
    put(home, ACC_A, '{ 不是 json');
    put(home, ACC_B, JSON.stringify(PINNED));
    const ctx = ctxFor(home, ['claude']);
    const lines = applyModelPins(ctx, new Backups(home, PLATFORM, NOW));
    expectKind(lines, keyOf(CLAUDE), 'unknown');
    expectKind(lines, keyOf(ACC_A), 'unknown');
    expect(textOf(lines, ACC_A)).toContain('没查成');
    expectKind(lines, keyOf(ACC_B), 'changed');
    expect(get(home, ACC_A)).toBe('{ 不是 json');
    expect(exitCode(lines)).toBe(2); // 没查成，不是没做成（1）
  });

  it('没有这些文件：什么都不报', () => {
    const m = machine({});
    expect(m.check()).toEqual([]);
    expect(m.apply()).toEqual([]);
  });
});
