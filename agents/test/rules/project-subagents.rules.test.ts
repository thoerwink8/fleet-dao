// 钉住决定 0036「本仓的子代理定义写进仓里 .claude/agents/，派活默认用它们」（创始人 2026-10-09 21:41～21:44：
// 「subagent 全写到项目里，以后默认用新写的 subagent」）。改标准：改这个文件要创始人同意
// （packages/conventions/standard-paths.json 的 agents/test/rules/）。
// 钉五处：
// 1. 名单：16 个 fleet-* 子代理，文件名、name、该用哪一档（Haiku 6、Sonnet 6、Opus 4）一个不多一个不少；加减都要改这里，
//    也就是走改标准。
// 2. 模型：只许完整 id claude-haiku-5-5 / claude-sonnet-5-5 / claude-opus-5-5。别名（haiku 在本机指向 4.5；
//    同族别名还会被主会话的模型顶替）、inherit、Fable、没写模型，都不行。
// 3. 权限：每个都写明 tools 白名单（没写就继承全部工具）；带 Edit 的必须 isolation: worktree；
//    Haiku 档除 fleet-fixer 外不许有 Edit。
// 4. 汇报：每个正文都要求汇报首行写自己的模型 id（派完核对实际 id 靠它）；Haiku 档都限回合数。
// 5. 指挥官技能、参考页、标准路径清单都写着「默认用 fleet-* 子代理」和这条测试。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AGENTS_DIR = `${ROOT}.claude/agents/`;
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

/** 名单：name → 该用的模型。加减子代理要改这里（走改标准） */
const ROSTER: Record<string, string> = {
  'fleet-scout': HAIKU,
  'fleet-log-digest': HAIKU,
  'fleet-triage': HAIKU,
  'fleet-review-screen': HAIKU,
  'fleet-fixer': HAIKU,
  'fleet-brief-drafter': HAIKU,
  'fleet-builder': SONNET,
  'fleet-ui-builder': SONNET,
  'fleet-ci-triager': SONNET,
  'fleet-ui-verifier': SONNET,
  'fleet-researcher': SONNET,
  'fleet-groomer': SONNET,
  'fleet-standard-editor': OPUS,
  'fleet-architect': OPUS,
  'fleet-debugger': OPUS,
  'fleet-reviewer': OPUS,
};

/** Haiku 档里唯一可以带 Edit 的 */
const HAIKU_MAY_EDIT = ['fleet-fixer'];

interface Parsed {
  fm: Record<string, string>;
  body: string;
}

/** 认 frontmatter（只认一行一个 key: value，和 skills 那种缩进列表）；认不出明确报错 */
function parse(file: string, text: string): Parsed {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}：认不出 frontmatter`);
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined) fm[kv[1]] = (kv[2] ?? '').trim();
  }
  return { fm, body: m[2] ?? '' };
}

/** 一份定义的毛病；空数组才算对 */
function problems(file: string, text: string): string[] {
  const { fm, body } = parse(file, text);
  const out: string[] = [];
  const name = fm.name ?? '';
  if (!(name in ROSTER)) out.push(`${file}：name「${name}」不在名单里`);
  if (`${name}.md` !== file) out.push(`${file}：文件名和 name「${name}」对不上`);
  if (!fm.description) out.push(`${file}：没写 description`);
  const want = ROSTER[name];
  if (fm.model === undefined) out.push(`${file}：没写 model`);
  else if (want !== undefined && fm.model !== want)
    out.push(`${file}：model 是「${fm.model}」，该是 ${want}`);
  if (!fm.model || !/^claude-(haiku|sonnet|opus)-5-5$/.test(fm.model))
    out.push(`${file}：model 必须是 5.5 的完整 id，不许别名、inherit、Fable`);
  if (!fm.tools) out.push(`${file}：没写 tools 白名单（没写就继承全部工具）`);
  const tools = (fm.tools ?? '').split(',').map((t) => t.trim());
  if (tools.includes('Edit') && fm.isolation !== 'worktree')
    out.push(`${file}：带 Edit 却没写 isolation: worktree`);
  if (fm.model === HAIKU && tools.includes('Edit') && !HAIKU_MAY_EDIT.includes(name))
    out.push(`${file}：Haiku 档只有 ${HAIKU_MAY_EDIT.join('、')} 可以带 Edit`);
  if (fm.model === HAIKU && !/^\d+$/.test(fm.maxTurns ?? '')) out.push(`${file}：Haiku 档要限 maxTurns`);
  if (!fm.effort) out.push(`${file}：没写 effort`);
  if (!/汇报：第一行写 `模型: <你自己的模型 id>`/.test(body))
    out.push(`${file}：正文没要求汇报首行写自己的模型 id`);
  return out;
}

const files = existsSync(AGENTS_DIR)
  ? readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
  : [];
const texts = Object.fromEntries(files.map((f) => [f, read(`${AGENTS_DIR}${f}`)]));
/** 某个定义的原文；文件不在明确报错 */
function textOf(file: string): string {
  const t = texts[file];
  if (t === undefined) throw new Error(`.claude/agents/${file} 不存在`);
  return t;
}

const SKILL = read(`${ROOT}agents/skills/commander/SKILL.md`);
const GUIDE = read(`${ROOT}agents/skills/commander/references/子代理选模型.md`);
const STANDARD = read(`${ROOT}packages/conventions/standard-paths.json`);

describe('规矩：本仓子代理定义在 .claude/agents/，名单、模型、权限、汇报固定（决定 0036）', () => {
  it('名单：恰好是这 16 个 fleet-* 文件，一个不多一个不少', () => {
    expect(files).toEqual(
      Object.keys(ROSTER)
        .map((n) => `${n}.md`)
        .sort(),
    );
  });

  it('每份定义：模型是 5.5 的完整 id 且对档、写了 tools 白名单、带 Edit 的在独立工作树、Haiku 限回合、汇报首行写模型 id', () => {
    const all = files.flatMap((f) => problems(f, textOf(f)));
    expect(all).toEqual([]);
  });

  it('档位分布：Haiku 6、Sonnet 6、Opus 4', () => {
    const count = (m: string) => Object.values(ROSTER).filter((v) => v === m).length;
    expect([count(HAIKU), count(SONNET), count(OPUS)]).toEqual([6, 6, 4]);
  });

  it('【故意造出的失败】模型改成别名 / inherit / Fable / 旧版 / 删掉：都查得出来', () => {
    const f = 'fleet-builder.md';
    const base = textOf(f);
    for (const bad of ['sonnet', 'inherit', 'claude-fable-5-1', 'claude-sonnet-4-5', 'claude-opus-5-5']) {
      const cut = base.replace(/^model: .*$/m, `model: ${bad}`);
      expect(cut, '找不到 model 那一行，这条失败造不出来').not.toBe(base);
      expect(problems(f, cut), bad).not.toEqual([]);
    }
    const noModel = base.replace(/^model: .*\n/m, '');
    expect(noModel).not.toBe(base);
    expect(problems(f, noModel)).toContain(`${f}：没写 model`);
  });

  it('【故意造出的失败】删掉 tools、去掉 isolation、让 Haiku 带 Edit 或不限回合、去掉汇报首行：都查得出来', () => {
    const builder = textOf('fleet-builder.md');
    const noTools = builder.replace(/^tools: .*\n/m, '');
    expect(noTools).not.toBe(builder);
    expect(problems('fleet-builder.md', noTools)).toContain(
      'fleet-builder.md：没写 tools 白名单（没写就继承全部工具）',
    );
    const noIso = builder.replace(/^isolation: .*\n/m, '');
    expect(noIso).not.toBe(builder);
    expect(problems('fleet-builder.md', noIso)).toContain(
      'fleet-builder.md：带 Edit 却没写 isolation: worktree',
    );
    const scout = textOf('fleet-scout.md');
    const edit = scout.replace(/^tools: .*$/m, 'tools: Read, Edit');
    expect(edit).not.toBe(scout);
    expect(problems('fleet-scout.md', edit).length).toBeGreaterThanOrEqual(2);
    const noTurns = scout.replace(/^maxTurns: .*\n/m, '');
    expect(noTurns).not.toBe(scout);
    expect(problems('fleet-scout.md', noTurns)).toContain('fleet-scout.md：Haiku 档要限 maxTurns');
    const noReport = scout.replace('汇报：第一行写 `模型: <你自己的模型 id>`', '汇报：');
    expect(noReport).not.toBe(scout);
    expect(problems('fleet-scout.md', noReport)).toContain(
      'fleet-scout.md：正文没要求汇报首行写自己的模型 id',
    );
  });

  it('【故意造出的失败】认不出 frontmatter：明确报错，不当成没毛病', () => {
    expect(() => problems('fleet-x.md', '没有 frontmatter')).toThrow(/认不出 frontmatter/);
  });

  it('指挥官技能、参考页、标准路径清单都写着：默认用 fleet-* 子代理、定义在 .claude/agents/', () => {
    expect(SKILL).toMatch(/本仓默认用 `\.claude\/agents\/` 里的 `fleet-\*` 子代理/);
    expect(GUIDE).toMatch(/\n## 本仓的子代理名单（决定 0036）\n/);
    expect(GUIDE).toContain('`.claude/agents/`');
    for (const name of Object.keys(ROSTER)) expect(GUIDE, name).toContain(`\`${name}\``);
    expect(STANDARD).toContain('.claude/agents/');
  });
});
