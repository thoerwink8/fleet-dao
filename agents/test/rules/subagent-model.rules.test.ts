// 钉住子代理选模型的规矩：决定 0034「默认值只许 Opus 或 Sonnet、子代理和工人永不用 Fable」（创始人 2026-10-09 00:09 授权
// 「改成最具有性价比的调整方案……全程你拍板」）、决定 0035「按产出能不能被核对选档、先小模型核对不过再升」（创始人 2026-10-09 08:28），
// 和决定 0087「子代理只分三个角色」（创始人 2026-10-12「Sonnet 是工人、Haiku 是斥候、Opus 是设计」，取代 0035 的 haiku55 派法）。
// 改标准：改这个文件要创始人同意（packages/conventions/standard-paths.json 的 agents/test/rules/）。
// 只读 agents/ 里的文件、claude-permissions.json 和 docs/decisions/0087。
// 钉三处：
// 1. 设置里的环境变量：agents/config/claude-permissions.json 的 env 由同步工具写进每台机器的 ~/.claude/settings.json。
//    - CLAUDE_CODE_SUBAGENT_MODEL（没写类型、自定义又没写模型的子代理的兜底）只许 Opus 或 Sonnet：兜底落到 Haiku，写代码的活就悄悄
//      跑在小模型上；不写就跟主会话，主会话可能是 Fable。这里自己判、不借同步工具的校验（permissions.ts 的 OPUS_OR_SONNET），
//      那边哪天被放宽了，这条照样红。它排在定义之后，压不住三个角色（决定 0087 本机实测）。
//    - CLAUDE_CODE_SUBAGENT_MODEL_FORCE、CLAUDE_CODE_EFFORT_LEVEL、CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL 不许写：前两个压过定义里的
//      model、effort，三个角色的钉就失效；第三个把 workflow 里的 agent() 全换成一个模型。
// 2. 通用段「我的机器与模型」：三个角色和各自的内置名、升档传 model、不另造类型、核对实际 id、先斥候核对不过再升级、不符连败升一档。
// 3. 决定 0087 的要点：原话、三个角色、派法、完整型号、一份原件、页面别改、环境变量、只有 Claude Code 读、实测表、取代关系。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const CONFIG = read('../../config/claude-permissions.json');
const SHARED = read('../../shared-rules.md');
const DECISION = read('../../../docs/decisions/0087-three-subagent-roles.md');

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

/** 通用段「我的机器与模型」里写子代理的那一行；认不出明确报错 */
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
  三个角色:
    /子代理只分三个角色：斥候 Haiku 5\.5（`Explore`）、工人 Sonnet 5\.5（`general-purpose`）、设计 Opus 5\.5（`Plan`）/,
  升档传model: /升档传 model/,
  不另造类型: /不另造类型/,
  核对实际id: /核对实际 id/,
  先斥候核对不过再升级: /能脚本核对的先给斥候、核对不过再升级/,
  升一档: /不符、连败升一档/,
};

/** 通用段那一行里不许再有的旧说法 */
const SHARED_FORBIDDEN: Record<string, RegExp> = {
  haiku55: /haiku55/,
  fleet子代理: /fleet-[a-z]/,
};

/** 决定 0087 必须写着的 */
const DECISION_RULES: Record<string, RegExp> = {
  原话三个角色: /Sonnet 是工人、Haiku 是斥候、Opus 是设计/,
  原话能删的删: /你能删的删/,
  原话每台机器: /每一台机器都要沿用这种方式/,
  原话2026_10_12_20_26: /2026-10-12 20:26（北京时间）\n\n1a/,
  原话页面别改: /这三份不在 Mirasim 智能体页面里改\/开关/,
  斥候: /斥候 `Explore`：`claude-haiku-5-5`，effort medium，只读/,
  工人: /工人 `general-purpose`：`claude-sonnet-5-5`，effort medium/,
  设计: /设计 `Plan`：`claude-opus-5-5`，effort high，只读/,
  全删: /其余 16 个 `fleet-\*` 和 `haiku55` 全删/,
  派法: /不传 `model`，用定义里的钉。难的活升档才传 `model`/,
  Workflow: /`agent\(\)` 的 `agentType` 填这三个名字/,
  完整型号: /型号一律写完整 id/,
  一份原件: /原件只有一份/,
  归仓里管: /这三份归仓里管/,
  撤旧的: /清单 `~\/\.fleet-dao\/agents-sync\.json` 记着是同步装的才撤（先备份）/,
  环境变量: /`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`、`CLAUDE_CODE_EFFORT_LEVEL` 不得设置/,
  只有ClaudeCode读: /只有 Claude Code 读这些定义文件[^\n]*Codex、Cursor、Grok、Devin 不读/,
  实测表: /\n## 本机实测（2026-10-12，Claude Code 2\.1\.296）\n/,
  取代: /- 取代：0036 全部[^\n]*0079 全部/,
  法国没验证: /\n## 没验证的\n[\s\S]*2\.1\.282/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

function present(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => re.test(text))
    .map(([name]) => name);
}

describe('规矩：设置里的环境变量不压三个角色的钉，兜底只许 Opus 或 Sonnet（决定 0034、0087）', () => {
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

describe('规矩：子代理只分三个角色、核对实际 id、先斥候核对不过再升级（决定 0035、0087）', () => {
  it('通用段那一行：三个角色和内置名、升档传 model、不另造类型、核对实际 id、先斥候、升一档都在；haiku55、fleet-* 不在了', () => {
    expect(missing(SHARED_RULES, tierLine(SHARED))).toEqual([]);
    expect(present(SHARED_FORBIDDEN, tierLine(SHARED))).toEqual([]);
  });

  it('决定 0087 的要点都在：原话、三个角色、派法、完整型号、一份原件、页面别改、环境变量、只有 Claude Code 读、实测表、取代、法国没验证', () => {
    expect(missing(DECISION_RULES, DECISION)).toEqual([]);
  });

  it('【故意造出的失败】通用段拿掉升级规则、拿掉斥候、拿掉「不另造类型」、退回 haiku55：各自查得出来', () => {
    const line = tierLine(SHARED);
    const cuts: [from: string, to: string, rule: string][] = [
      ['，不符、连败升一档', '', '升一档'],
      ['斥候 Haiku 5.5（`Explore`）、', '', '三个角色'],
      ['，不另造类型', '', '不另造类型'],
      ['，升档传 model', '', '升档传model'],
      ['能脚本核对的先给斥候、核对不过再升级', '能脚本核对的先 Haiku', '先斥候核对不过再升级'],
    ];
    for (const [from, to, rule] of cuts) {
      const cut = line.replace(from, to);
      expect(cut, `那一行里找不到「${from}」，这条失败造不出来`).not.toBe(line);
      expect(missing(SHARED_RULES, cut), `拿掉「${from}」`).toEqual([rule]);
    }
    const old = line.replace('核对实际 id', '核对实际 id（Haiku 用 haiku55）');
    expect(present(SHARED_FORBIDDEN, old)).toEqual(['haiku55']);
    const fleet = line.replace('（`Explore`）', '（`fleet-scout`）');
    expect(present(SHARED_FORBIDDEN, fleet)).toEqual(['fleet子代理']);
  });

  it('【故意造出的失败】认不出通用段那一节：明确报错，不当成空行算过', () => {
    expect(() => tierLine('# 没有通用段的文件')).toThrow(/认不出「## 我的机器与模型」一节/);
  });

  it('【故意造出的失败】决定 0087 删掉原话时间、「只有 Claude Code 读」、环境变量那条：都查得出来', () => {
    const noTime = DECISION.replace('2026-10-12 20:26（北京时间）', '2026-10-12（北京时间）');
    expect(noTime, '决定里找不到那个时间，这条失败造不出来').not.toBe(DECISION);
    expect(missing(DECISION_RULES, noTime)).toEqual(['原话2026_10_12_20_26']);
    const noReaders = DECISION.replace('只有 Claude Code 读这些定义文件', '各家都读这些定义文件');
    expect(noReaders).not.toBe(DECISION);
    expect(missing(DECISION_RULES, noReaders)).toEqual(['只有ClaudeCode读']);
    const noEnv = DECISION.replace('不得设置', '可以设置');
    expect(noEnv).not.toBe(DECISION);
    expect(missing(DECISION_RULES, noEnv)).toEqual(['环境变量']);
  });
});
