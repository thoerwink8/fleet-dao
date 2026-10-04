// 钉住决定 0017「子代理只用 Opus 或 Sonnet，永不用 Fable」落在设置里的那一步（改标准：改这个文件要创始人同意，
// packages/conventions/standard-paths.json 的 agents/test/rules/）。仓里 agents/config/claude-permissions.json 的
// env.CLAUDE_CODE_SUBAGENT_MODEL 由同步工具写进每台机器的 ~/.claude/settings.json：Claude Code 起子代理时，调用和子代理定义
// 都没写模型就用它；不设就跟主会话同一个模型，而主会话可能是创始人自己选的 Fable。
// 这里自己判一遍、不借同步工具的校验（packages/agents-sync/src/permissions.ts 的 OPUS_OR_SONNET）：那边哪天被放宽了，这条照样红。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONFIG = readFileSync(
  fileURLToPath(new URL('../../config/claude-permissions.json', import.meta.url)),
  'utf8',
);

/** 只认这两家（决定 0017）；Fable、Mythos、Haiku，还有 inherit、best、default 这类不是一个固定家的，都不算 */
const ALLOWED = ['opus', 'sonnet'];

/** 源文件里的子代理默认模型。没写、不是字符串都明确报错，不当成「没有就算过」 */
function subagentModel(text: string): string {
  const root = JSON.parse(text.replace(/^﻿/, '')) as { env?: Record<string, unknown> };
  const value = root.env?.CLAUDE_CODE_SUBAGENT_MODEL;
  if (value === undefined)
    throw new Error('agents/config/claude-permissions.json 里没有 env.CLAUDE_CODE_SUBAGENT_MODEL');
  if (typeof value !== 'string') throw new Error('env.CLAUDE_CODE_SUBAGENT_MODEL 不是字符串');
  return value;
}

/** 模型属于哪一家：别名（opus、sonnet……）原样，完整 id 取 claude-<家>-<版本> 里的家，可带 [1m]；认不出是 null */
function family(model: string): string | null {
  const m = /^(?:([a-z]+)|claude-([a-z]+)-\d+(?:-\d+)*)(?:\[1m\])?$/.exec(model);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** 把源文件里那一项换成 value（找不到那一项就原样返回，调用方要断言确实换了） */
function withModel(value: string): string {
  return CONFIG.replace(
    /"CLAUDE_CODE_SUBAGENT_MODEL":\s*"[^"]*"/,
    `"CLAUDE_CODE_SUBAGENT_MODEL": ${JSON.stringify(value)}`,
  );
}

describe('规矩：子代理默认模型只用 Opus 或 Sonnet（决定 0017）', () => {
  it('仓里的子代理默认模型是 Opus 或 Sonnet', () => {
    expect(ALLOWED).toContain(family(subagentModel(CONFIG)));
  });

  it('认家的写法：别名、完整 id、带 [1m] 的都认得出', () => {
    expect(family('opus')).toBe('opus');
    expect(family('sonnet[1m]')).toBe('sonnet');
    expect(family('claude-opus-5-5')).toBe('opus');
    expect(family('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(family('claude-fable-5-1[1m]')).toBe('fable');
    expect(family('Claude Opus')).toBeNull();
  });

  it('【故意造出的失败】改成 Fable（id、别名、带 1M）、Mythos、Haiku：都查得出来', () => {
    for (const bad of [
      'claude-fable-5-1',
      'claude-fable-5',
      'fable',
      'fable[1m]',
      'claude-mythos-5-1',
      'claude-haiku-4-5',
      'haiku',
    ]) {
      const text = withModel(bad);
      expect(text, '源文件里找不到那一项，这条失败造不出来').not.toBe(CONFIG);
      expect(ALLOWED, bad).not.toContain(family(subagentModel(text)));
    }
  });

  it('【故意造出的失败】改成 inherit、default、best、opusplan（跟主会话走、或不是一个固定的家）：都查得出来', () => {
    for (const bad of ['inherit', 'default', 'best', 'opusplan', '']) {
      const text = withModel(bad);
      expect(text).not.toBe(CONFIG);
      expect(ALLOWED, bad).not.toContain(family(subagentModel(text)));
    }
  });

  it('【故意造出的失败】整项删掉、写成不是字符串：明确报错，不当成没事', () => {
    const gone = CONFIG.replace(/"env":\s*\{[^}]*\},?/, '');
    expect(gone, '源文件里找不到 env 那一段，这条失败造不出来').not.toBe(CONFIG);
    expect(() => subagentModel(gone)).toThrow(/没有 env\.CLAUDE_CODE_SUBAGENT_MODEL/);
    const notString = CONFIG.replace(
      /"CLAUDE_CODE_SUBAGENT_MODEL":\s*"[^"]*"/,
      '"CLAUDE_CODE_SUBAGENT_MODEL": 5',
    );
    expect(notString).not.toBe(CONFIG);
    expect(() => subagentModel(notString)).toThrow(/不是字符串/);
  });
});
