// 钉住决定 0034「子代理按性价比选模型」（创始人 2026-10-09 00:09 授权「改成最具有性价比的调整方案……全程你拍板」，
// 取代 0017 第 2 条的「只用 Opus 或 Sonnet」，「永不用 Fable」保留）和决定 0035「Haiku 5.5 按产出能被机器核对用」
// （创始人 2026-10-09 08:28「haiku5.5能力边界你去探查清楚……怎么能大范围使用，节约我的成本」、08:36「你现在调用的是haiku4.5，
// 要调用haiku5.5」）。改标准：改这个文件要创始人同意（packages/conventions/standard-paths.json 的 agents/test/rules/）。
// 只读 agents/ 里的文件、claude-permissions.json 和 docs/decisions/0035。
// 钉四处：
// 1. 设置里的默认：agents/config/claude-permissions.json 的 env.CLAUDE_CODE_SUBAGENT_MODEL 由同步工具写进每台机器的
//    ~/.claude/settings.json，调用和子代理定义都没写模型时就用它。默认值只许 Opus 或 Sonnet：Haiku 只在派活时逐个显式选，
//    兜底落到 Haiku，写代码的活就悄悄跑在小模型上了。这里自己判、不借同步工具的校验（permissions.ts 的 OPUS_OR_SONNET），
//    那边哪天被放宽了，这条照样红。
// 2. 通用段「我的机器与模型」：三档、核对实际 id、Haiku 用 haiku55、先 Haiku 核对不过再升级、不符连败升一档。
// 3. 指挥官技能和它的参考页：按能不能核对选档、haiku55 的派法（别名 haiku 在本机是 4.5）、级联（Haiku 核对不过就升，
//    Sonnet/Opus 同档两次失败升）、交代写全硬规矩和核对办法、汇报实际模型 id、先砍固定开销、Haiku 结论动手前抽查、
//    无人值守的监控以脚本为主、补单草稿先跑 check-brief.mjs。
// 4. 决定 0035 的七点：坑和派法、边界、级联、交代写全、先砍固定开销、实测数据和样本小、引擎侧由创始人配。
// 5. haiku55 随同步装到每台机器（#1393，创始人 2026-10-09 21:29～21:41「都按照你推荐，不要小修，要改彻底」）：
//    原件 agents/subagents/haiku55.md 的 name、完整 id、精简的 tools 白名单、汇报首行写模型 id；
//    packages/agents-sync/src/targets.ts 的 SUBAGENT_TARGET 列着它（按文本核，不跨包 import）；参考页和决定 0035 写着「同步会装上」。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const CONFIG = read('../../config/claude-permissions.json');
const SHARED = read('../../shared-rules.md');
const SKILL = read('../../skills/commander/SKILL.md');
const GUIDE = read('../../skills/commander/references/子代理选模型.md');
const DECISION = read('../../../docs/decisions/0035-haiku55-by-checkable-output.md');
const H55 = read('../../subagents/haiku55.md');
const TARGETS = read('../../../packages/agents-sync/src/targets.ts');

/** 仓里 haiku55 定义的毛病；空数组才算对。认不出 frontmatter 明确报错，不当成没毛病 */
function h55Problems(text: string): string[] {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error('agents/subagents/haiku55.md：认不出 frontmatter');
  const fm: Record<string, string> = {};
  for (const l of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(l);
    if (kv?.[1] !== undefined) fm[kv[1]] = (kv[2] ?? '').trim();
  }
  const out: string[] = [];
  if (fm.name !== 'haiku55') out.push('name 不是 haiku55');
  // 只认完整 id：别名 haiku 在本机指向 4.5，正是这个子代理要绕开的坑
  if (fm.model !== 'claude-haiku-5-5')
    out.push(`model 是「${fm.model ?? '没写'}」，该是完整 id claude-haiku-5-5`);
  if (!fm.tools) out.push('没写 tools 白名单（没写就继承全部工具，含 MCP）');
  const tools = (fm.tools ?? '').split(',').map((t) => t.trim());
  if (tools.some((t) => ['Agent', 'Task', 'Skill'].includes(t) || t.startsWith('mcp__')))
    out.push('tools 里有子代理、技能或 MCP，不是精简配置');
  if (!/First line of your report: `模型: <your model id>`/.test(m[2] ?? ''))
    out.push('正文没要求汇报首行写模型 id');
  return out;
}

/** targets.ts 的 SUBAGENT_TARGET 里列没列 haiku55.md；认不出这一项明确报错 */
function syncListsH55(targets: string): boolean {
  const block = /\nexport const SUBAGENT_TARGET\b[\s\S]*?\n\};/.exec(targets)?.[0];
  if (block === undefined) throw new Error('packages/agents-sync/src/targets.ts 里认不出 SUBAGENT_TARGET');
  return /\bfiles:\s*\[[^\]]*'haiku55\.md'[^\]]*\]/.test(block);
}

/** 默认值只认这两家；Fable、Mythos、Haiku，还有 inherit、best、default 这类不是一个固定家的，都不算 */
const DEFAULT_ALLOWED = ['opus', 'sonnet'];
/** 派活时能显式选的三家：Sonnet、Opus 走 Agent 工具的 model 别名，Haiku 5.5 走 subagent_type "haiku55"；Haiku 不在默认里 */
const DISPATCH_ALLOWED = ['haiku', 'sonnet', 'opus'];
/** 派活时技能里必须写着的写法：别名 haiku 在本机指向 4.5，所以 Haiku 那一家写的是 subagent_type */
const DISPATCH_SPELLING: Record<string, string> = {
  haiku: '`subagent_type: "haiku55"`',
  sonnet: '`"sonnet"`',
  opus: '`"opus"`',
};

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
  核对实际id: /三档，核对实际 id/,
  haiku55: /Haiku 用 haiku55/,
  先Haiku核对不过再升级: /能脚本核对的先 Haiku、核对不过再升级/,
  升一档: /不符、连败升一档/,
};

/** 指挥官技能和参考页必须写着的 */
const GUIDE_RULES: Record<string, [text: 'SKILL' | 'GUIDE', re: RegExp]> = {
  技能指向参考页: ['SKILL', /`references\/子代理选模型\.md`/],
  技能先Haiku核对不过再升: [
    'SKILL',
    /产出能被脚本或一条命令核对的先给 Haiku 5\.5[^\n]*核对不过再升 Sonnet 5\.5，不在同档重试/,
  ],
  技能派活写法: [
    'SKILL',
    /`model` 写明 `"sonnet"` 或 `"opus"`；Haiku 5\.5 写 `subagent_type: "haiku55"`、不传 `model`/,
  ],
  技能说清别名haiku是4点5: ['SKILL', /别名 `"haiku"` 在本机指向 Haiku 4\.5，不用/],
  技能派Haiku写全规矩和核对: ['SKILL', /派 Haiku 时交代里把用到的硬规矩逐条写全、写明拿什么核对/],
  汇报首行写模型id: [
    'SKILL',
    /汇报首行写自己的模型 id（`claude-haiku-5-5`、`claude-sonnet-5-5`、`claude-opus-5-5`）/,
  ],
  技能监控用haiku55: ['SKILL', /短命的 Haiku 5\.5 子代理（`subagent_type: "haiku55"`）/],
  补单草稿先跑检查脚本: [
    'SKILL',
    /补单交给 Sonnet 或 Haiku 写草稿后，开单前先跑这个脚本：`node \$S\/check-brief\.mjs/,
  ],
  按能不能核对选档: ['GUIDE', /按「产出能不能被脚本或一条命令核对」选档，不按活的名字/],
  别名haiku是4点5: ['GUIDE', /别名 `haiku` 在本机指向 Haiku 4\.5，不是 5\.5/],
  派haiku55不传model: ['GUIDE', /写 `subagent_type: "haiku55"`，不传 `model`/],
  没装haiku55不拿haiku顶: ['GUIDE', /这次给 Sonnet，不拿 `"haiku"` 顶/],
  同步装haiku55: [
    'GUIDE',
    /原件在仓里 `agents\/subagents\/haiku55\.md`，`pnpm agents:sync`[^\n]*装到每台机器的用户级子代理目录/,
  ],
  costUSD不当账: ['GUIDE', /`costUSD` 对 5\.5 不准/],
  档位表Haiku: ['GUIDE', /\n\| 读码检索[^\n]*\| Haiku 5\.5（`haiku55`） \|/],
  档位表Haiku修bug: ['GUIDE', /\n\| 规格明确的小函数、有失败测试的 bug 修复 \| Haiku 5\.5（`haiku55`） \|/],
  档位表Haiku写任务书配脚本: ['GUIDE', /\n\| 按写全的规矩写任务书草稿 \| Haiku 5\.5[^\n]*check-brief\.mjs/],
  档位表Sonnet: ['GUIDE', /\n\| 没有机器核对的写代码[^\n]*\| Sonnet 5\.5 \|/],
  档位表Opus: ['GUIDE', /\n\| 改标准[^\n]*\| Opus 5\.5 \|/],
  Haiku核对不过就升: ['GUIDE', /Haiku：核对它的脚本或命令不过[^\n]*就升到 Sonnet 重做/],
  同档两次失败升一档: ['GUIDE', /Sonnet、Opus：同档连着失败两次，升一档/],
  Haiku只回证据不归因: ['GUIDE', /只回证据行，不归因/],
  交代写全硬规矩: ['GUIDE', /\*\*用到的每条硬规矩都逐条写出来\*\*/],
  派之前定好核对: ['GUIDE', /派之前就定好核对它的脚本或命令/],
  先砍固定开销: ['GUIDE', /\n## 先砍固定开销\n/],
  Haiku结论动手前抽查: ['GUIDE', /据 Haiku 的结论动手之前，自己用一条命令抽查/],
  能写完整id处写完整id: ['GUIDE', /一律写完整 id、不写别名/],
  监控主体是脚本: ['GUIDE', /监控的主体是脚本，不是模型/],
  监控OK不叫模型: ['GUIDE', /`VERDICT: OK`：不叫任何模型/],
  监控只在ALERT且DELTA才叫haiku55: [
    'GUIDE',
    /`VERDICT: ALERT <n>` 且 `DELTA` 不为 0：派一个短命的 `haiku55` 子代理（`subagent_type: "haiku55"`/,
  ],
  亲自巡三个触发: ['GUIDE', /连续 3 个周期没读到 `VERDICT` 行；出现 `BROKEN`；据 Haiku 的摘要要动手修之前/],
  每天自检: ['GUIDE', /每天至少跑一次 `patrol\.mjs --selftest`/],
  给监控留一个名额: ['GUIDE', /无人值守时给监控留 1 个，干活的最多 3 个/],
};

/** 决定 0035 必须写着的七点（每点至少一个关键词） */
const DECISION_RULES: Record<string, RegExp> = {
  坑_别名是4点5: /别名 `haiku` 在本机指向 Haiku 4\.5/,
  坑_用haiku55: /`subagent_type: "haiku55"`，\*\*不传 `model`\*\*/,
  坑_定义文件: /`~\/\.claude\/agents\/haiku55\.md`，frontmatter 里 `model: claude-haiku-5-5`/,
  坑_同步装上: /原件在仓里 `agents\/subagents\/haiku55\.md`，`pnpm agents:sync` 把它装到每台机器/,
  坑_命令行: /`claude -p --model claude-haiku-5-5/,
  坑_核对实际id不是就停: /不是 `claude-haiku-5-5` 就停/,
  坑_costUSD不当账: /`costUSD` 对 5\.5 不准[^\n]*不能当账/,
  边界_按能不能核对: /不按活的名字，按「产出能被脚本或一条命令核对」/,
  边界_清单:
    /读码检索[^\n]*日志和 CI 输出归纳[^\n]*分类[^\n]*准入和范围检查[^\n]*评审初筛[^\n]*规格明确的小函数[^\n]*有失败测试的 bug 修复[^\n]*按写全的规矩写任务书/,
  级联: /先 Haiku，脚本核对不过就升 Sonnet，不在同档重试/,
  级联_仍给Sonnet或Opus: /开放式长链编码、改标准、架构方案、下结论的评审/,
  交代写全: /交代必须写全所有硬规矩/,
  先砍固定开销: /先砍固定开销[\s\S]{0,200}精简配置/,
  限制回合: /限制回合数/,
  实测数据表: /\n## 实测数据\n[\s\S]*\n\| 题 \| 结果 \|\n/,
  样本小免责: /样本小/,
  引擎侧变体路由关着: /Haiku 5\.5 的变体路由（关着）/,
  引擎侧由创始人配: /由创始人在驾驶舱定，AI 不替他配/,
  部分取代0034: /取代：决定 0034/,
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

  it('派活能选的三家里有 Haiku，默认能用的两家里没有；技能里三家各有写法（Haiku 写 subagent_type "haiku55"）', () => {
    expect(DISPATCH_ALLOWED).toContain('haiku');
    expect(DEFAULT_ALLOWED).not.toContain('haiku');
    for (const f of DISPATCH_ALLOWED) expect(SKILL, f).toContain(DISPATCH_SPELLING[f]);
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

describe('规矩：子代理按性价比分三档、核对实际 id、Haiku 5.5 走 haiku55、先 Haiku 核对不过再升级（决定 0034、0035）', () => {
  it('通用段那一行：三档、核对实际 id、haiku55、先 Haiku 核对不过再升级、升一档都在', () => {
    expect(missing(SHARED_RULES, tierLine(SHARED))).toEqual([]);
  });

  it('指挥官技能和参考页：按能不能核对选档、haiku55 的派法、级联、交代写全、先砍固定开销、汇报实际 id、抽查、监控以脚本为主、补单先跑检查脚本都在', () => {
    expect(missingGuide({ SKILL, GUIDE })).toEqual([]);
  });

  it('决定 0035 的七点都在：坑和派法、边界、级联、交代写全、先砍固定开销、实测数据和样本小、引擎侧由创始人配', () => {
    expect(missing(DECISION_RULES, DECISION)).toEqual([]);
  });

  it('【故意造出的失败】通用段拿掉升级规则、拿掉 Haiku 那一档、拿掉级联：各自查得出来', () => {
    const line = tierLine(SHARED);
    const cuts: [from: string, rule: string][] = [
      ['，不符、连败升一档', '升一档'],
      ['Haiku 5.5、', '三档'],
      ['，能脚本核对的先 Haiku、核对不过再升级', '先Haiku核对不过再升级'],
    ];
    for (const [from, rule] of cuts) {
      const cut = line.replace(from, '');
      expect(cut, `那一行里找不到「${from}」，这条失败造不出来`).not.toBe(line);
      expect(missing(SHARED_RULES, cut), `拿掉「${from}」`).toEqual([rule]);
    }
  });

  it('【故意造出的失败】参考页把 Haiku 改回「同档两次失败才升」、监控改回每个周期都叫模型、派法改回 model: "haiku"：查得出来', () => {
    const lax = GUIDE.replace(/Haiku：核对它的脚本或命令不过[^\n]*/, 'Haiku：同档连着失败两次再升。');
    expect(lax, '参考页里找不到 Haiku 的升级规则，这条失败造不出来').not.toBe(GUIDE);
    expect(missingGuide({ SKILL, GUIDE: lax })).toEqual(['Haiku核对不过就升']);
    const everyCycle = GUIDE.replace('`VERDICT: OK`：不叫任何模型', '每个周期派一个 Haiku 子代理读全量输出');
    expect(everyCycle).not.toBe(GUIDE);
    expect(missingGuide({ SKILL, GUIDE: everyCycle })).toEqual(['监控OK不叫模型']);
    const alias = GUIDE.replace('写 `subagent_type: "haiku55"`，不传 `model`', '写 `model: "haiku"`');
    expect(alias).not.toBe(GUIDE);
    expect(missingGuide({ SKILL, GUIDE: alias })).toEqual(['派haiku55不传model']);
  });

  it('【故意造出的失败】认不出通用段那一节：明确报错，不当成空行算过', () => {
    expect(() => tierLine('# 没有通用段的文件')).toThrow(/认不出「## 我的机器与模型」一节/);
  });

  it('【故意造出的失败】把「核对实际 id」或「haiku55」删掉（通用段、技能、决定 0035）：都查得出来', () => {
    const line = tierLine(SHARED);
    const noCheck = line.replace('，核对实际 id', '');
    expect(noCheck, '那一行里找不到「核对实际 id」，这条失败造不出来').not.toBe(line);
    expect(missing(SHARED_RULES, noCheck)).toEqual(['核对实际id']);
    const noH55 = line.replaceAll('haiku55', '');
    expect(noH55, '那一行里找不到 haiku55，这条失败造不出来').not.toBe(line);
    expect(missing(SHARED_RULES, noH55)).toEqual(['haiku55']);
    const skillNoH55 = SKILL.replaceAll('haiku55', 'haiku');
    expect(skillNoH55).not.toBe(SKILL);
    expect(missingGuide({ SKILL: skillNoH55, GUIDE })).toEqual(['技能派活写法', '技能监控用haiku55']);
    const decisionNoH55 = DECISION.replaceAll('haiku55', 'haiku');
    expect(decisionNoH55).not.toBe(DECISION);
    expect(missing(DECISION_RULES, decisionNoH55)).toEqual(['坑_用haiku55', '坑_定义文件', '坑_同步装上']);
    const decisionNoCheck = DECISION.replace('不是 `claude-haiku-5-5` 就停', '对一下');
    expect(decisionNoCheck).not.toBe(DECISION);
    expect(missing(DECISION_RULES, decisionNoCheck)).toEqual(['坑_核对实际id不是就停']);
  });
});

describe('规矩：haiku55 定义在仓里、随 agents:sync 装到每台机器（#1393）', () => {
  it('仓里的 agents/subagents/haiku55.md：name、完整 id、精简的 tools 白名单、汇报首行写模型 id 都对', () => {
    expect(h55Problems(H55)).toEqual([]);
  });

  it('同步工具的名单（targets.ts 的 SUBAGENT_TARGET）列着 haiku55.md', () => {
    expect(syncListsH55(TARGETS)).toBe(true);
  });

  it('【故意造出的失败】模型改成别名、旧版、Sonnet 或删掉，删掉 tools、塞进 MCP，去掉汇报首行：都查得出来', () => {
    for (const bad of ['haiku', 'claude-haiku-4-5', 'inherit', 'claude-sonnet-5-5']) {
      const cut = H55.replace(/^model: .*$/m, `model: ${bad}`);
      expect(cut, '找不到 model 那一行，这条失败造不出来').not.toBe(H55);
      expect(h55Problems(cut), bad).toHaveLength(1);
    }
    const noModel = H55.replace(/^model: .*\n/m, '');
    expect(noModel).not.toBe(H55);
    expect(h55Problems(noModel)).toEqual(['model 是「没写」，该是完整 id claude-haiku-5-5']);
    const noTools = H55.replace(/^tools: .*\n/m, '');
    expect(noTools).not.toBe(H55);
    expect(h55Problems(noTools)).toEqual(['没写 tools 白名单（没写就继承全部工具，含 MCP）']);
    const mcp = H55.replace(/^tools: (.*)$/m, 'tools: $1, mcp__codegraph__codegraph_explore');
    expect(mcp).not.toBe(H55);
    expect(h55Problems(mcp)).toEqual(['tools 里有子代理、技能或 MCP，不是精简配置']);
    const noReport = H55.replace('First line of your report: `模型: <your model id>`.', '');
    expect(noReport).not.toBe(H55);
    expect(h55Problems(noReport)).toEqual(['正文没要求汇报首行写模型 id']);
    expect(() => h55Problems('没有 frontmatter')).toThrow(/认不出 frontmatter/);
  });

  it('【故意造出的失败】名单里去掉 haiku55.md、或认不出 SUBAGENT_TARGET：都查得出来', () => {
    const dropped = TARGETS.replace(/(\nexport const SUBAGENT_TARGET\b[\s\S]*?files: \[)'haiku55\.md'/, '$1');
    expect(dropped, 'targets.ts 里找不到那一项，这条失败造不出来').not.toBe(TARGETS);
    expect(syncListsH55(dropped)).toBe(false);
    const gone = TARGETS.replace('export const SUBAGENT_TARGET', 'export const SOMETHING_ELSE');
    expect(gone).not.toBe(TARGETS);
    expect(() => syncListsH55(gone)).toThrow(/认不出 SUBAGENT_TARGET/);
  });

  it('【故意造出的失败】参考页、决定 0035 删掉「同步会装上」：查得出来', () => {
    const guideCut = GUIDE.replace(/原件在仓里 `agents\/subagents\/haiku55\.md`，/, '');
    expect(guideCut, '参考页里找不到那一句，这条失败造不出来').not.toBe(GUIDE);
    expect(missingGuide({ SKILL, GUIDE: guideCut })).toEqual(['同步装haiku55']);
    const decisionCut = DECISION.replace(/原件在仓里 `agents\/subagents\/haiku55\.md`，/, '');
    expect(decisionCut).not.toBe(DECISION);
    expect(missing(DECISION_RULES, decisionCut)).toEqual(['坑_同步装上']);
  });
});
