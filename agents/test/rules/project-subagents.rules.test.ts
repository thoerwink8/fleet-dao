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
// 6. 通用版随同步装到每台机器的用户级（决定 0079，创始人 2026-10-11「我希望未来每台有fleet-dao的机器，包括vps，都能具备最佳
//    subagent方式」，20:44「子代理 PR #1886：改成通用版，VPS 照装」）：
//    - .claude/agents/ 下每份都有同名通用版 agents/subagents/<名>.md：name、description、model 逐份一致，tools 只少
//      mcp__codegraph__*，tools 以外的 frontmatter 逐行一致；通用版也过上面那套定义检查。
//    - 通用版全文不含仓专属词（词表 REPO_ONLY，只写这一处），tools 不含 mcp__codegraph__。
//    - packages/agents-sync/src/targets.ts 的 SUBAGENT_TARGET 恰好列着 agents/subagents/ 下全部 17 份（16 通用版加
//      haiku55，按文本核，不跨包 import），不装 .claude/agents/ 那份；参考页写着「同步装的是通用版」。
// 另钉一处（#1844 方案第十节 9b）：fleet-ui-builder 照 docs/design/驾驶舱界面.md、lint-design 必须绿，不再指旧令牌 #182；
// fleet-ui-verifier 点验对照这份规范。
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

/** 驾驶舱界面规范（#1844）：界面两个子代理都以它为准 */
const DESIGN_DOC = 'docs/design/驾驶舱界面.md';

/** 界面两个子代理和规范对不上的地方；空数组才算对 */
function uiDesignProblems(builder: string, verifier: string): string[] {
  const out: string[] = [];
  if (!builder.includes(`照 \`${DESIGN_DOC}\``)) out.push(`fleet-ui-builder.md：没写照 \`${DESIGN_DOC}\``);
  if (!/lint-design[^\n]*必须绿/.test(builder)) out.push('fleet-ui-builder.md：没写 lint-design 必须绿');
  if (/#182/.test(builder)) out.push('fleet-ui-builder.md：还指向旧令牌 #182');
  if (!verifier.includes(`对照 \`${DESIGN_DOC}\``))
    out.push(`fleet-ui-verifier.md：点验没对照 \`${DESIGN_DOC}\``);
  return out;
}

const SKILL = read(`${ROOT}agents/skills/commander/SKILL.md`);
const GUIDE = read(`${ROOT}agents/skills/commander/references/子代理选模型.md`);
const STANDARD = read(`${ROOT}packages/conventions/standard-paths.json`);
const TARGETS = read(`${ROOT}packages/agents-sync/src/targets.ts`);

/** 通用版的目录：装到每台机器用户级的原件都在这里（和 haiku55 同目录） */
const GENERIC_DIR = `${ROOT}agents/subagents/`;
const genericFiles = existsSync(GENERIC_DIR)
  ? readdirSync(GENERIC_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
  : [];
const genericTexts = Object.fromEntries(genericFiles.map((f) => [f, read(`${GENERIC_DIR}${f}`)]));
/** 某个通用版的原文；文件不在明确报错 */
function genericOf(file: string): string {
  const t = genericTexts[file];
  if (t === undefined) throw new Error(`agents/subagents/${file} 不存在`);
  return t;
}

/** 同步该装的：agents/subagents/ 下的文件名，haiku55 加名单里每一份的通用版（排好序） */
const SYNC_WANT = ['haiku55.md', ...Object.keys(ROSTER).map((n) => `${n}.md`)].sort();

/**
 * 仓专属词：通用版装到每台机器、别的仓的会话也读，正文里出现这些就是把 fleet-dao 的规矩带过去了。
 * 加词只改这里。每项：说法、怎么认、一句故意造出失败用的样例。
 */
const REPO_ONLY: ReadonlyArray<readonly [string, RegExp, string]> = [
  ['pnpm', /pnpm/, '开 PR 用 `pnpm pr:open`'],
  [
    'pr:open 这类本仓脚本',
    /\b(pr:open|issue:new|issue:close|agents:sync|progress:note)\b/,
    '收尾跑 issue:close',
  ],
  ['fleet 命令', /(^|[^\w-])fleet(?![\w-])/m, '用 `fleet say` 报进度'],
  ['codegraph', /codegraph/i, '先用 codegraph 查'],
  ['_tmp', /_tmp/, '截图放 `_tmp/ui/`'],
  ['docs/', /docs\//, '先读 `docs/design.md`'],
  ['specs/', /specs\//, '方案写进 `specs/1-x/方案.md`'],
  ['AGENTS.md', /AGENTS\.md/, '照 AGENTS.md 做'],
  ['.claude/', /\.claude\//, '定义在 `.claude/agents/`'],
  ['决定编号', /决定\s*0\d/, '见决定 0036'],
  ['agents/ 下的路径', /(^|[^\w.])agents\//m, '不碰 `agents/skills/`'],
  ['packages/ 下的路径', /packages\//, '只改 `packages/web`'],
  ['check-brief', /check-brief/, '跑 check-brief.mjs'],
  ['standard-paths', /standard-paths/, '先读 standard-paths.json'],
  ['shared-rules', /shared-rules/, '通用段在 shared-rules.md'],
  ['lint-design', /lint-design/, 'lint-design 必须绿'],
  ['指挥官', /指挥官/, '由指挥官升档'],
  ['驾驶舱', /驾驶舱/, '点验驾驶舱'],
  ['fleet-dao', /fleet-dao/, '照 fleet-dao 的规矩'],
];

/** frontmatter 原文的各行（认不出明确报错） */
function fmLines(file: string, text: string): string[] {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`${file}：认不出 frontmatter`);
  return (m[1] ?? '').split('\n');
}

const toolsOf = (fm: Record<string, string>) =>
  (fm.tools ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');

/** 一份项目级定义和它的通用版对不上的地方；空数组才算对。通用版缺了明确报出来 */
function pairProblems(file: string, project: string, generic: string | undefined): string[] {
  if (generic === undefined) return [`${file}：agents/subagents/ 下没有同名通用版`];
  const p = parse(file, project).fm;
  const g = parse(file, generic).fm;
  const out: string[] = [];
  for (const key of ['name', 'description', 'model'] as const)
    if (p[key] !== g[key]) out.push(`${file}：通用版的 ${key} 和 .claude/agents/ 那份不一样`);
  const strip = (lines: string[]) => lines.filter((l) => !/^tools:/.test(l));
  if (strip(fmLines(file, project)).join('\n') !== strip(fmLines(file, generic)).join('\n'))
    out.push(`${file}：通用版 tools 以外的 frontmatter 和 .claude/agents/ 那份不一样`);
  const want = toolsOf(p).filter((t) => !t.startsWith('mcp__codegraph__'));
  if (toolsOf(g).join(', ') !== want.join(', '))
    out.push(`${file}：通用版的 tools 该是「${want.join(', ')}」（只去掉 mcp__codegraph__*）`);
  return out;
}

/** 一份通用版里的仓专属内容；空数组才算对 */
function genericProblems(file: string, text: string): string[] {
  const out: string[] = [];
  if (toolsOf(parse(file, text).fm).some((t) => t.startsWith('mcp__codegraph__')))
    out.push(`${file}：通用版的 tools 带了 mcp__codegraph__`);
  for (const [label, re] of REPO_ONLY) if (re.test(text)) out.push(`${file}：通用版里有仓专属的「${label}」`);
  return out;
}

/** targets.ts 的 SUBAGENT_TARGET 里 files 列的仓内路径（排好序）；认不出这一项明确报错，不当成空名单 */
function syncFiles(targets: string): string[] {
  const block = /\nexport const SUBAGENT_TARGET\b[\s\S]*?\n\};/.exec(targets)?.[0];
  if (block === undefined) throw new Error('packages/agents-sync/src/targets.ts 里认不出 SUBAGENT_TARGET');
  const list = /\bfiles:\s*\[([^\]]*)\]/.exec(block)?.[1];
  if (list === undefined) throw new Error('SUBAGENT_TARGET 里认不出 files: [...]');
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();
}

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

  it('界面两个子代理照驾驶舱界面规范：builder 照 docs/design/驾驶舱界面.md 且 lint-design 必须绿，verifier 点验对照它（#1844 9b）', () => {
    expect(existsSync(`${ROOT}${DESIGN_DOC}`), `${DESIGN_DOC} 不存在`).toBe(true);
    expect(uiDesignProblems(textOf('fleet-ui-builder.md'), textOf('fleet-ui-verifier.md'))).toEqual([]);
  });

  it('【故意造出的失败】builder 退回「见 #182」、去掉 lint-design，或 verifier 不提规范：都查得出来', () => {
    const builder = textOf('fleet-ui-builder.md');
    const verifier = textOf('fleet-ui-verifier.md');
    const old = builder.replace(
      /照 `docs\/design\/驾驶舱界面\.md`[^\n]*?必须绿/,
      '设计 token 用仓里已有的（见 #182）',
    );
    expect(old, '找不到 builder 那一行，这条失败造不出来').not.toBe(builder);
    expect(uiDesignProblems(old, verifier).length).toBeGreaterThanOrEqual(2);
    const noLint = builder.replaceAll('lint-design', 'lint');
    expect(noLint).not.toBe(builder);
    expect(uiDesignProblems(noLint, verifier)).toEqual(['fleet-ui-builder.md：没写 lint-design 必须绿']);
    const noDoc = verifier.replaceAll(DESIGN_DOC, '');
    expect(noDoc).not.toBe(verifier);
    expect(uiDesignProblems(builder, noDoc)).toEqual([`fleet-ui-verifier.md：点验没对照 \`${DESIGN_DOC}\``]);
  });

  it('指挥官技能、参考页、标准路径清单都写着：默认用 fleet-* 子代理、定义在 .claude/agents/', () => {
    expect(SKILL).toMatch(/本仓默认用 `\.claude\/agents\/` 里的 `fleet-\*` 子代理/);
    expect(GUIDE).toMatch(/\n## 本仓的子代理名单（决定 0036）\n/);
    expect(GUIDE).toContain('`.claude/agents/`');
    for (const name of Object.keys(ROSTER)) expect(GUIDE, name).toContain(`\`${name}\``);
    expect(STANDARD).toContain('.claude/agents/');
  });
});

/** 参考页里写「同步装的是通用版」的那一句 */
const GUIDE_SYNC =
  /`pnpm agents:sync` 把这 16 份的通用版（`agents\/subagents\/` 下同名[^）]*）装到每台机器的 `~\/\.claude\/agents\/`/;

describe('规矩：fleet-* 的通用版随 agents:sync 装到每台机器的用户级，本仓仍用 .claude/agents/ 那份（决定 0079）', () => {
  it('每份 .claude/agents/fleet-*.md 都有同名通用版：name、description、model 一致，tools 只少 mcp__codegraph__*', () => {
    expect(files.length).toBe(16);
    expect(files.flatMap((f) => pairProblems(f, textOf(f), genericTexts[f]))).toEqual([]);
  });

  it('通用版也过同一套定义检查（完整模型 id、tools 白名单、带 Edit 的在独立工作树、Haiku 限回合、汇报首行写模型 id）', () => {
    expect(files.flatMap((f) => problems(f, genericOf(f)))).toEqual([]);
  });

  it('通用版全文不含仓专属词、tools 不含 mcp__codegraph__', () => {
    expect(files.flatMap((f) => genericProblems(f, genericOf(f)))).toEqual([]);
  });

  it('同步工具的名单（targets.ts 的 SUBAGENT_TARGET）恰好是 agents/subagents/ 下这 17 份，一个不多一个不少', () => {
    expect(genericFiles).toEqual(SYNC_WANT);
    expect(syncFiles(TARGETS)).toEqual(SYNC_WANT);
  });

  it('参考页写着：同步装的是通用版，本仓里项目级那份优先', () => {
    expect(GUIDE).toMatch(GUIDE_SYNC);
    expect(GUIDE).toContain('决定 0079');
  });

  it('【故意造出的失败】通用版缺一份、description 或 model 不一样、tools 以外的字段改了、tools 多去或少去：都查得出来', () => {
    const f = 'fleet-builder.md';
    const project = textOf(f);
    const generic = genericOf(f);
    expect(pairProblems(f, project, undefined)).toEqual([`${f}：agents/subagents/ 下没有同名通用版`]);
    const desc = generic.replace(/^description: .*$/m, 'description: 改过的说明');
    expect(desc).not.toBe(generic);
    expect(pairProblems(f, project, desc)).toContain(
      `${f}：通用版的 description 和 .claude/agents/ 那份不一样`,
    );
    const model = generic.replace(/^model: .*$/m, 'model: claude-opus-5-5');
    expect(model).not.toBe(generic);
    expect(pairProblems(f, project, model)).toContain(`${f}：通用版的 model 和 .claude/agents/ 那份不一样`);
    const effort = generic.replace(/^effort: .*$/m, 'effort: low');
    expect(effort).not.toBe(generic);
    expect(pairProblems(f, project, effort)).toEqual([
      `${f}：通用版 tools 以外的 frontmatter 和 .claude/agents/ 那份不一样`,
    ]);
    const lessTools = generic.replace(/^tools: .*$/m, 'tools: Read, Grep');
    expect(lessTools).not.toBe(generic);
    expect(pairProblems(f, project, lessTools).join('\n')).toMatch(/通用版的 tools 该是/);
  });

  it('【故意造出的失败】通用版里写进每一个仓专属词、tools 带回 codegraph：逐个查得出来', () => {
    const f = 'fleet-builder.md';
    const generic = genericOf(f);
    for (const [label, , sample] of REPO_ONLY) {
      const bad = generic.replace('做法：', `做法：${sample}。`);
      expect(bad, '找不到「做法：」，这条失败造不出来').not.toBe(generic);
      expect(genericProblems(f, bad), label).toContain(`${f}：通用版里有仓专属的「${label}」`);
    }
    const withCg = generic.replace(/^tools: (.*)$/m, 'tools: $1, mcp__codegraph__codegraph_explore');
    expect(withCg).not.toBe(generic);
    expect(genericProblems(f, withCg)).toContain(`${f}：通用版的 tools 带了 mcp__codegraph__`);
    // 别的子代理的名字（fleet-reviewer 这种）不算 fleet 命令
    expect(genericProblems(f, generic.replace('做法：', '做法：先让 fleet-reviewer 看。'))).toEqual([]);
  });

  it('【故意造出的失败】名单里去掉一份、多出一份、认不出 SUBAGENT_TARGET 或 files：都查得出来', () => {
    const dropped = TARGETS.replace(/\n\s*'fleet-reviewer\.md',?/, '');
    expect(dropped, 'targets.ts 里找不到 fleet-reviewer 那一项，这条失败造不出来').not.toBe(TARGETS);
    expect(syncFiles(dropped)).not.toEqual(SYNC_WANT);
    const extra = TARGETS.replace("'haiku55.md'", "'haiku55.md', 'fleet-x.md'");
    expect(extra).not.toBe(TARGETS);
    expect(syncFiles(extra)).not.toEqual(SYNC_WANT);
    const gone = TARGETS.replace('export const SUBAGENT_TARGET', 'export const SOMETHING_ELSE');
    expect(gone).not.toBe(TARGETS);
    expect(() => syncFiles(gone)).toThrow(/认不出 SUBAGENT_TARGET/);
    expect(() => syncFiles('\nexport const SUBAGENT_TARGET = {\n  dir: x,\n};')).toThrow(/认不出 files/);
  });

  it('【故意造出的失败】参考页删掉「同步装的是通用版」：查得出来', () => {
    const cut = GUIDE.replace(GUIDE_SYNC, '');
    expect(cut, '参考页里找不到那一句，这条失败造不出来').not.toBe(GUIDE);
    expect(cut).not.toMatch(GUIDE_SYNC);
  });
});
