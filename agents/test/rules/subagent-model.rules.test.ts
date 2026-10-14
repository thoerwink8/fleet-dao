// 钉住子代理选模型的设置：兜底默认值只许 Opus 或 Sonnet、子代理和工人不用 Fable，三个角色的模型钉不被环境变量压掉。
// 改标准：改这个文件要创始人同意（packages/conventions/standard-paths.json 的 agents/test/rules/）。
// 只钉设置、不钉文字：agents/config/claude-permissions.json 的 env 由同步工具写进 ~/.claude/settings.json——除了装了 mirasim-reclaude
// 启动器的桌面机（决定 0092：那里不写、已有的删掉，Mirasim 见到这个键会误判拦截；这个例外的用例在 packages/agents-sync/test/permissions.test.ts）。
// 源文件里的值照旧只许 Opus 或 Sonnet，别的机器照旧写。
// - CLAUDE_CODE_SUBAGENT_MODEL（没写类型、自定义又没写模型的子代理的兜底）只许 Opus 或 Sonnet：兜底落到 Haiku，写代码的活就悄悄
//   跑在小模型上；不写就跟主会话，主会话可能是 Fable。这里自己判、不借同步工具的校验（permissions.ts 的 OPUS_OR_SONNET），
//   那边哪天被放宽了，这条照样红。它排在定义之后，压不住三个角色（本机实测过）。
// - CLAUDE_CODE_SUBAGENT_MODEL_FORCE、CLAUDE_CODE_EFFORT_LEVEL、CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL 不许写：前两个压过定义里的
//   model、effort，三个角色的钉就失效；第三个把 workflow 里的 agent() 全换成一个模型。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const CONFIG = read('../../config/claude-permissions.json');

/** 默认值只认这两家；Fable、Mythos、Haiku，还有 inherit、best、default 这类不是一个固定家的，都不算 */
const DEFAULT_ALLOWED = ['opus', 'sonnet'];
/** 会压掉三个角色的钉、不许写进 env 的变量 */
const FORBIDDEN_ENV = [
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL',
];

/** 源文件里的 env；没写、不是对象都明确报错，不当成「没有就算过」 */
function envOf(text: string): Record<string, unknown> {
  const root = JSON.parse(text.replace(/^﻿/, '')) as { env?: unknown };
  if (root.env === undefined) throw new Error('agents/config/claude-permissions.json 里没有 env');
  if (typeof root.env !== 'object' || root.env === null || Array.isArray(root.env))
    throw new Error('agents/config/claude-permissions.json 的 env 不是对象');
  return root.env as Record<string, unknown>;
}

/** 源文件里的子代理默认模型。没写、不是字符串都明确报错 */
function subagentModel(text: string): string {
  const value = envOf(text).CLAUDE_CODE_SUBAGENT_MODEL;
  if (value === undefined)
    throw new Error('agents/config/claude-permissions.json 里没有 env.CLAUDE_CODE_SUBAGENT_MODEL');
  if (typeof value !== 'string') throw new Error('env.CLAUDE_CODE_SUBAGENT_MODEL 不是字符串');
  return value;
}

/** env 里写了的、会压掉钉的变量 */
const forbiddenEnv = (text: string) => FORBIDDEN_ENV.filter((k) => k in envOf(text));

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

describe('规矩：设置里的环境变量不压三个角色的钉，兜底只许 Opus 或 Sonnet', () => {
  it('仓里的子代理默认模型是 Opus 或 Sonnet', () => {
    expect(DEFAULT_ALLOWED).toContain(family(subagentModel(CONFIG)));
  });

  it('env 里没有压掉钉的变量（FORCE、EFFORT_LEVEL、WORKFLOW_SUBAGENT_MODEL）', () => {
    expect(forbiddenEnv(CONFIG)).toEqual([]);
  });

  it('认家的写法：别名、完整 id、带 [1m] 的都认得出', () => {
    expect(family('opus')).toBe('opus');
    expect(family('sonnet[1m]')).toBe('sonnet');
    expect(family('claude-opus-5-5')).toBe('opus');
    expect(family('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(family('claude-haiku-5-5')).toBe('haiku');
    expect(family('claude-fable-5-1[1m]')).toBe('fable');
    expect(family('Claude Opus')).toBeNull();
  });

  it('【故意造出的失败】默认值改成 Haiku（5.5 的完整 id、旧版、别名）、Fable、Mythos、inherit 这类：都查得出来', () => {
    for (const bad of [
      'claude-haiku-5-5',
      'claude-haiku-4-5',
      'haiku',
      'haiku[1m]',
      'claude-fable-5-1',
      'fable',
      'claude-mythos-5-1',
      'inherit',
      'default',
      'best',
      'opusplan',
      '',
    ]) {
      const text = withModel(bad);
      expect(text, '源文件里找不到那一项，这条失败造不出来').not.toBe(CONFIG);
      expect(DEFAULT_ALLOWED, bad).not.toContain(family(subagentModel(text)));
    }
  });

  it('【故意造出的失败】env 里写上 FORCE、EFFORT_LEVEL、WORKFLOW_SUBAGENT_MODEL：逐个查得出来', () => {
    for (const key of FORBIDDEN_ENV) {
      const text = CONFIG.replace(/"env":\s*\{/, `"env": { "${key}": "1",`);
      expect(text, '源文件里找不到 env 那一段，这条失败造不出来').not.toBe(CONFIG);
      expect(forbiddenEnv(text), key).toEqual([key]);
    }
  });

  it('【故意造出的失败】整项删掉、写成不是字符串、env 整段没了：明确报错，不当成没事', () => {
    const gone = CONFIG.replace(/"env":\s*\{[^}]*\},?/, '');
    expect(gone, '源文件里找不到 env 那一段，这条失败造不出来').not.toBe(CONFIG);
    expect(() => subagentModel(gone)).toThrow(/没有 env/);
    expect(() => forbiddenEnv(gone)).toThrow(/没有 env/);
    const notString = CONFIG.replace(
      /"CLAUDE_CODE_SUBAGENT_MODEL":\s*"[^"]*"/,
      '"CLAUDE_CODE_SUBAGENT_MODEL": 5',
    );
    expect(notString).not.toBe(CONFIG);
    expect(() => subagentModel(notString)).toThrow(/不是字符串/);
  });
});
