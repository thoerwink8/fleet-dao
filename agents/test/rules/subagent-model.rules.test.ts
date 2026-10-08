// 钉住决定 0034「子代理按性价比选模型」（创始人 2026-10-09 00:09 授权「改成最具有性价比的调整方案……全程你拍板」，
// 取代 0017 第 2 条的「只用 Opus 或 Sonnet」，「永不用 Fable」保留）。改标准：改这个文件要创始人同意
// （packages/conventions/standard-paths.json 的 agents/test/rules/）。只读 agents/ 里的文件和 claude-permissions.json。
// 钉三处：
// 1. 设置里的默认：agents/config/claude-permissions.json 的 env.CLAUDE_CODE_SUBAGENT_MODEL 由同步工具写进每台机器的
//    ~/.claude/settings.json，调用和子代理定义都没写模型时就用它。默认值只许 Opus 或 Sonnet：Haiku 只在派活时逐个显式选，
//    兜底落到 Haiku，写代码的活就悄悄跑在小模型上了。这里自己判、不借同步工具的校验（permissions.ts 的 OPUS_OR_SONNET），
//    那边哪天被放宽了，这条照样红。
// 2. 通用段「我的机器与模型」：三档、写明模型并核对实际 id、升一档。
// 3. 指挥官技能和它的参考页：档位表、升级规则（Haiku 一次没证据就升，Sonnet/Opus 同档两次失败升）、交代里要汇报实际模型 id、
//    Haiku 结论动手前抽查、无人值守的监控以脚本为主。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const CONFIG = read('../../config/claude-permissions.json');
const SHARED = read('../../shared-rules.md');
const SKILL = read('../../skills/commander/SKILL.md');
const GUIDE = read('../../skills/commander/references/子代理选模型.md');

/** 默认值只认这两家；Fable、Mythos、Haiku，还有 inherit、best、default 这类不是一个固定家的，都不算 */
const DEFAULT_ALLOWED = ['opus', 'sonnet'];
/** 派活时能显式选的三家（Agent 工具的 model 别名）：Haiku 在这里，不在默认里 */
const DISPATCH_ALLOWED = ['haiku', 'sonnet', 'opus'];

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

/** 通用段「我的机器与模型」里写子代理档位的那一行；认不出明确报错 */
function tierLine(text: string): string {
  const start = text.indexOf('\n## 我的机器与模型\n');
  const end = text.indexOf('<!-- fleet-dao:通用段 结束 -->');
  if (start < 0 || end < start)
    throw new Error('agents/shared-rules.md 通用段里认不出「## 我的机器与模型」一节');
  const line = text
    .slice(start, end)
    .split('\n')
    .find((l) => l.includes('子代理'));
  if (line === undefined) throw new Error('「我的机器与模型」一节里没有写子代理的那一行');
  return line;
}

/** 通用段那一行必须写着的 */
const SHARED_RULES: Record<string, RegExp> = {
  三档: /子代理按性价比分 Haiku 5\.5、Sonnet 5\.5、Opus 5\.5 三档/,
  写明模型核对实际id: /写明模型、核对实际 id/,
  升一档: /对不上、没证据或连败就升一档/,
};

/** 指挥官技能和参考页必须写着的 */
const GUIDE_RULES: Record<string, [text: 'SKILL' | 'GUIDE', re: RegExp]> = {
  技能指向参考页: ['SKILL', /`references\/子代理选模型\.md`/],
  派活写明三个别名: ['SKILL', /一律写明 `"haiku"`、`"sonnet"` 或 `"opus"`/],
  汇报首行写模型id: [
    'SKILL',
    /汇报首行写自己的模型 id（`claude-haiku-5-5`、`claude-sonnet-5-5`、`claude-opus-5-5`）/,
  ],
  档位表Haiku: ['GUIDE', /\n\| 读码检索[^\n]*\| Haiku 5\.5 \|/],
  档位表Sonnet: ['GUIDE', /\n\| 写代码[^\n]*\| Sonnet 5\.5 \|/],
  档位表Opus: ['GUIDE', /\n\| 改标准[^\n]*\| Opus 5\.5 \|/],
  Haiku一次没证据就升: ['GUIDE', /Haiku：一次产出里没有可抽查的证据[^\n]*就升到 Sonnet 重做/],
  同档两次失败升一档: ['GUIDE', /Sonnet、Opus：同档连着失败两次，升一档/],
  Haiku只回证据不归因: ['GUIDE', /只回证据行，不归因/],
  Haiku结论动手前抽查: ['GUIDE', /据 Haiku 的结论动手之前，自己用一条命令抽查/],
  能写完整id处写完整id: ['GUIDE', /一律写完整 id、不写别名/],
  监控主体是脚本: ['GUIDE', /监控的主体是脚本，不是模型/],
  监控OK不叫模型: ['GUIDE', /`VERDICT: OK`：不叫任何模型/],
  监控只在ALERT且DELTA才叫Haiku: [
    'GUIDE',
    /`VERDICT: ALERT <n>` 且 `DELTA` 不为 0：派一个短命的 Haiku 子代理/,
  ],
  亲自巡三个触发: ['GUIDE', /连续 3 个周期没读到 `VERDICT` 行；出现 `BROKEN`；据 Haiku 的摘要要动手修之前/],
  每天自检: ['GUIDE', /每天至少跑一次 `patrol\.mjs --selftest`/],
  给监控留一个名额: ['GUIDE', /无人值守时给监控留 1 个，干活的最多 3 个/],
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

function missingGuide(texts: { SKILL: string; GUIDE: string }): string[] {
  return Object.entries(GUIDE_RULES)
    .filter(([, [which, re]]) => !re.test(texts[which]))
    .map(([name]) => name);
}

describe('规矩：子代理默认模型只许 Opus 或 Sonnet，Haiku 只在派活时显式选（决定 0034）', () => {
  it('仓里的子代理默认模型是 Opus 或 Sonnet', () => {
    expect(DEFAULT_ALLOWED).toContain(family(subagentModel(CONFIG)));
  });

  it('派活能选的三家里有 Haiku，默认能用的两家里没有', () => {
    expect(DISPATCH_ALLOWED).toContain('haiku');
    expect(DEFAULT_ALLOWED).not.toContain('haiku');
    for (const f of DISPATCH_ALLOWED) expect(SKILL, f).toContain(`\`"${f}"\``);
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

  it('【故意造出的失败】默认值改成 Haiku（5.5 的完整 id、旧版、别名）：都查得出来', () => {
    for (const bad of ['claude-haiku-5-5', 'claude-haiku-4-5', 'haiku', 'haiku[1m]']) {
      const text = withModel(bad);
      expect(text, '源文件里找不到那一项，这条失败造不出来').not.toBe(CONFIG);
      expect(DEFAULT_ALLOWED, bad).not.toContain(family(subagentModel(text)));
    }
  });

  it('【故意造出的失败】默认值改成 Fable（id、别名、带 1M）、Mythos：都查得出来', () => {
    for (const bad of ['claude-fable-5-1', 'claude-fable-5', 'fable', 'fable[1m]', 'claude-mythos-5-1']) {
      const text = withModel(bad);
      expect(text, '源文件里找不到那一项，这条失败造不出来').not.toBe(CONFIG);
      expect(DEFAULT_ALLOWED, bad).not.toContain(family(subagentModel(text)));
    }
  });

  it('【故意造出的失败】改成 inherit、default、best、opusplan（跟主会话走、或不是一个固定的家）：都查得出来', () => {
    for (const bad of ['inherit', 'default', 'best', 'opusplan', '']) {
      const text = withModel(bad);
      expect(text).not.toBe(CONFIG);
      expect(DEFAULT_ALLOWED, bad).not.toContain(family(subagentModel(text)));
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

describe('规矩：子代理按性价比分三档、核对实际 id、升一档（决定 0034）', () => {
  it('通用段那一行：三档、写明模型并核对实际 id、升一档都在', () => {
    expect(missing(SHARED_RULES, tierLine(SHARED))).toEqual([]);
  });

  it('指挥官技能和参考页：档位表、升级规则、汇报实际 id、Haiku 抽查、监控以脚本为主、并发留名额都在', () => {
    expect(missingGuide({ SKILL, GUIDE })).toEqual([]);
  });

  it('【故意造出的失败】通用段拿掉升级规则、拿掉 Haiku 那一档：各自查得出来', () => {
    const line = tierLine(SHARED);
    const noUpgrade = line.replace('，对不上、没证据或连败就升一档', '');
    expect(noUpgrade, '那一行里找不到升级规则，这条失败造不出来').not.toBe(line);
    expect(missing(SHARED_RULES, noUpgrade)).toEqual(['升一档']);
    const noHaiku = line.replace('Haiku 5.5、', '');
    expect(noHaiku).not.toBe(line);
    expect(missing(SHARED_RULES, noHaiku)).toEqual(['三档']);
  });

  it('【故意造出的失败】参考页把 Haiku 改回「同档两次失败才升」、监控改回每个周期都叫模型：查得出来', () => {
    const lax = GUIDE.replace(/Haiku：一次产出里没有可抽查的证据[^\n]*/, 'Haiku：同档连着失败两次再升。');
    expect(lax, '参考页里找不到 Haiku 的升级规则，这条失败造不出来').not.toBe(GUIDE);
    expect(missingGuide({ SKILL, GUIDE: lax })).toEqual(['Haiku一次没证据就升']);
    const everyCycle = GUIDE.replace('`VERDICT: OK`：不叫任何模型', '每个周期派一个 Haiku 子代理读全量输出');
    expect(everyCycle).not.toBe(GUIDE);
    expect(missingGuide({ SKILL, GUIDE: everyCycle })).toEqual(['监控OK不叫模型']);
  });

  it('【故意造出的失败】认不出通用段那一节：明确报错，不当成空行算过', () => {
    expect(() => tierLine('# 没有通用段的文件')).toThrow(/认不出「## 我的机器与模型」一节/);
  });
});
