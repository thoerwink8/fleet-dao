// 钉住「子代理只分三个角色，定义只有一份」的设置和结构；正文措辞不钉（改一句话就红的是钉文字，不是钉行为）。
// 改标准：改这个文件要创始人同意（packages/conventions/standard-paths.json 的 agents/test/rules/）。
// 钉这几处：
// 1. 名单：agents/subagents/ 下恰好三份，文件名和 name 就是 Claude Code 内置的 Explore、general-purpose、Plan（同名才压得住内置的）；
//    多一份、少一份、换名、大小写不对都红。
// 2. 模型：三份各钉自己那一档的完整 id（claude-haiku-5-5 / claude-sonnet-5-5 / claude-opus-5-5）。别名（网关下会落到旧版）、
//    inherit、Fable、旧版、换档、没写都红；effort 也钉死（medium / medium / high）。
// 3. 权限：斥候 Explore 和设计 Plan 只读——disallowedTools 带 Edit、Write，tools 白名单里也不许有它们；三份都不写 isolation
//    （工作树由派活时选；写了引擎会话里会整个挡掉）。
// 4. 三份都限回合数、都写 omitClaudeMd: true（主对话的回合、等待、报进度规矩不进子代理）。
// 5. 只有一份原件：仓里不许再有 .claude/agents/（同名项目级会压住用户级，两份就会漂移）；引擎读的目录（adapters 的 SUBAGENTS_DIR）
//    指到 agents/subagents；同步工具的名单（targets.ts 的 SUBAGENT_TARGET）恰好是这三份（按文本核，不跨包 import）。
// 6. 通用版：三份装到每台机器、别的仓的会话也读，正文不许带 fleet-dao 专属的命令、路径和决定编号。
// 7. 标准路径清单盖着 agents/subagents/。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIR = `${ROOT}agents/subagents/`;
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** 三个角色：内置名 → 该钉的完整 id、effort、是不是只读。加减角色要改这里（走改标准） */
const ROLES: Record<string, { model: string; effort: string; readOnly: boolean }> = {
  Explore: { model: 'claude-haiku-5-5', effort: 'medium', readOnly: true },
  'general-purpose': { model: 'claude-sonnet-5-5', effort: 'medium', readOnly: false },
  Plan: { model: 'claude-opus-5-5', effort: 'high', readOnly: true },
};
const WANT_FILES = Object.keys(ROLES)
  .map((n) => `${n}.md`)
  .sort();

interface Parsed {
  fm: Record<string, string>;
  body: string;
}

/** 认 frontmatter（只认一行一个 key: value）；认不出明确报错 */
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

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');

/** 目录里文件名的毛病：恰好三份、名字就是内置名（大小写也要对）；空数组才算对 */
function rosterProblems(files: readonly string[]): string[] {
  const out: string[] = [];
  const have = [...files].sort();
  for (const f of have)
    if (!WANT_FILES.includes(f))
      out.push(`agents/subagents/${f}：不是三个角色之一（只许 ${WANT_FILES.join('、')}）`);
  for (const f of WANT_FILES) if (!have.includes(f)) out.push(`agents/subagents/${f}：缺了`);
  return out;
}

/** 一份定义的毛病；空数组才算对 */
function problems(file: string, text: string): string[] {
  const { fm } = parse(file, text);
  const out: string[] = [];
  const name = fm.name ?? '';
  const role = ROLES[name];
  if (role === undefined) out.push(`${file}：name「${name}」不是三个角色之一`);
  if (`${name}.md` !== file) out.push(`${file}：文件名和 name「${name}」对不上`);
  if (!fm.description) out.push(`${file}：没写 description`);
  if (fm.model === undefined) out.push(`${file}：没写 model`);
  else if (role !== undefined && fm.model !== role.model)
    out.push(
      `${file}：model 是「${fm.model}」，该是完整 id ${role.model}（不许别名、inherit、Fable、旧版、换档）`,
    );
  if (role !== undefined && fm.effort !== role.effort)
    out.push(`${file}：effort 是「${fm.effort ?? '没写'}」，该是 ${role.effort}`);
  if (fm.isolation !== undefined) out.push(`${file}：不许写 isolation（工作树由派活时选）`);
  if (role?.readOnly) {
    const denied = list(fm.disallowedTools);
    for (const t of ['Edit', 'Write'])
      if (!denied.includes(t)) out.push(`${file}：只读的角色，disallowedTools 里要有 ${t}`);
    for (const t of list(fm.tools))
      if (['Edit', 'Write', 'NotebookEdit'].includes(t)) out.push(`${file}：只读的角色，tools 里不许有 ${t}`);
  }
  if (!/^\d+$/.test(fm.maxTurns ?? '')) out.push(`${file}：要限 maxTurns`);
  // 子代理不读主对话的全局说明（回合、等待、报进度那套只管主对话）
  if (fm.omitClaudeMd !== 'true') out.push(`${file}：要写 omitClaudeMd: true`);
  return out;
}

/**
 * 仓专属词：三份装到每台机器、别的仓的会话也读，正文里出现这些就是把 fleet-dao 的规矩带过去了。
 * 加词只改这里。每项：说法、怎么认、一句故意造出失败用的样例。
 */
const REPO_ONLY: ReadonlyArray<readonly [string, RegExp, string]> = [
  ['pnpm', /pnpm/, '开 PR 用 `pnpm pr:open`'],
  [
    'pr:open 这类本仓脚本',
    /\b(pr:open|issue:new|issue:close|agents:sync|progress note)\b/,
    '收尾跑 issue:close',
  ],
  ['fleet 命令', /(^|[^\w-])fleet(?![\w-])/m, '用 `fleet say` 报进度'],
  ['codegraph', /codegraph/i, '先用 codegraph 查'],
  ['_tmp', /_tmp/, '截图放 `_tmp/ui/`'],
  ['docs/', /docs\//, '先读 `docs/design.md`'],
  ['specs/', /specs\//, '方案写进 `specs/1-x/方案.md`'],
  ['AGENTS.md', /AGENTS\.md/, '照 AGENTS.md 做'],
  ['.claude/', /\.claude\//, '定义在 `.claude/agents/`'],
  ['决定编号', /决定\s*0\d/, '见决定 0087'],
  ['agents/ 下的路径', /(^|[^\w.])agents\//m, '不碰 `agents/skills/`'],
  ['packages/ 下的路径', /packages\//, '只改 `packages/web`'],
  ['standard-paths', /standard-paths/, '先读 standard-paths.json'],
  ['shared-rules', /shared-rules/, '通用段在 shared-rules.md'],
  ['指挥官', /指挥官/, '由指挥官升档'],
  ['驾驶舱', /驾驶舱/, '点验驾驶舱'],
  ['fleet-dao', /fleet-dao/, '照 fleet-dao 的规矩'],
];

/** 一份定义里的仓专属内容；空数组才算对 */
function repoOnlyProblems(file: string, text: string): string[] {
  const out: string[] = [];
  for (const [label, re] of REPO_ONLY) if (re.test(text)) out.push(`${file}：里面有仓专属的「${label}」`);
  return out;
}

/** targets.ts 的 SUBAGENT_TARGET 里 files 列的文件名（排好序）；认不出这一项明确报错，不当成空名单 */
function syncFiles(targets: string): string[] {
  const block = /\nexport const SUBAGENT_TARGET\b[\s\S]*?\n\};/.exec(targets)?.[0];
  if (block === undefined) throw new Error('packages/agents-sync/src/targets.ts 里认不出 SUBAGENT_TARGET');
  const files = /\bfiles:\s*\[([^\]]*)\]/.exec(block)?.[1];
  if (files === undefined) throw new Error('SUBAGENT_TARGET 里认不出 files: [...]');
  return [...files.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();
}

/** adapters 的 SUBAGENTS_DIR 指向的仓内目录；认不出明确报错 */
function engineDir(src: string): string {
  const m =
    /export const SUBAGENTS_DIR = fileURLToPath\(new URL\('((?:\.\.\/)+)([^']+)', import\.meta\.url\)\)/.exec(
      src,
    );
  if (!m) throw new Error('packages/adapters/src/claude-code/subagents.ts 里认不出 SUBAGENTS_DIR');
  return m[2] ?? '';
}

const files = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((f) => !f.startsWith('.') && f !== 'README.md') // README.md 是规范说明（subagent-readme.rules.test.ts 钉它）
      .sort()
  : [];
const texts = Object.fromEntries(files.map((f) => [f, read(`${DIR}${f}`)]));
function textOf(file: string): string {
  const t = texts[file];
  if (t === undefined) throw new Error(`agents/subagents/${file} 不存在`);
  return t;
}

const STANDARD = read(`${ROOT}packages/conventions/standard-paths.json`);
const TARGETS = read(`${ROOT}packages/agents-sync/src/targets.ts`);
const ADAPTER = read(`${ROOT}packages/adapters/src/claude-code/subagents.ts`);

describe('规矩：子代理只分三个角色，定义只有 agents/subagents/ 一份', () => {
  it('名单：agents/subagents/ 下恰好 Explore.md、general-purpose.md、Plan.md', () => {
    expect(rosterProblems(files)).toEqual([]);
  });

  it('每份定义：完整 id 和 effort 对档、只读的不带 Edit/Write、不写 isolation、限回合、不读主对话说明', () => {
    expect(files.flatMap((f) => problems(f, textOf(f)))).toEqual([]);
  });

  it('三份都不含 fleet-dao 专属的命令、路径和决定编号（装到每台机器、别的仓也读）', () => {
    expect(files.flatMap((f) => repoOnlyProblems(f, textOf(f)))).toEqual([]);
  });

  it('只有一份原件：仓里没有 .claude/agents/；引擎读 agents/subagents；同步名单恰好是这三份', () => {
    expect(
      existsSync(`${ROOT}.claude/agents`),
      '.claude/agents/ 又出现了：同名项目级会压住用户级，两份会漂移',
    ).toBe(false);
    expect(engineDir(ADAPTER)).toBe('agents/subagents');
    expect(syncFiles(TARGETS)).toEqual(WANT_FILES);
  });

  it('标准路径清单盖着 agents/subagents/', () => {
    expect(STANDARD).toContain('"agents/subagents/"');
    expect(STANDARD).not.toContain('".claude/agents/"');
  });

  it('【故意造出的失败】目录里多一份、少一份、换名、大小写不对：都查得出来', () => {
    expect(rosterProblems([...files, 'fleet-scout.md'])).toEqual([
      `agents/subagents/fleet-scout.md：不是三个角色之一（只许 ${WANT_FILES.join('、')}）`,
    ]);
    expect(rosterProblems(files.filter((f) => f !== 'Plan.md'))).toEqual(['agents/subagents/Plan.md：缺了']);
    const renamed = files.map((f) => (f === 'Explore.md' ? 'explore.md' : f));
    expect(rosterProblems(renamed)).toHaveLength(2);
    expect(rosterProblems([...files, 'haiku55.md']).length).toBe(1);
    // 换名但 frontmatter 照旧：文件名和 name 对不上
    expect(problems('Scout.md', textOf('Explore.md'))).toContain('Scout.md：文件名和 name「Explore」对不上');
  });

  it('【故意造出的失败】model 写别名、inherit、Fable、旧版、换档或删掉：三份各自查得出来', () => {
    for (const f of WANT_FILES) {
      const base = textOf(f);
      for (const bad of [
        'haiku',
        'sonnet',
        'opus',
        'inherit',
        'claude-fable-5-1',
        'claude-haiku-4-5',
        'claude-sonnet-4-6',
        'claude-opus-4-7',
      ]) {
        const cut = base.replace(/^model: .*$/m, `model: ${bad}`);
        expect(cut, `${f} 里找不到 model 那一行，这条失败造不出来`).not.toBe(base);
        expect(problems(f, cut), `${f} ${bad}`).not.toEqual([]);
      }
      const noModel = base.replace(/^model: .*\n/m, '');
      expect(noModel).not.toBe(base);
      expect(problems(f, noModel)).toContain(`${f}：没写 model`);
    }
    // 换档：斥候钉成 Sonnet、设计钉成 Sonnet
    const scoutSonnet = textOf('Explore.md').replace(/^model: .*$/m, 'model: claude-sonnet-5-5');
    expect(problems('Explore.md', scoutSonnet).join('\n')).toMatch(/该是完整 id claude-haiku-5-5/);
    const planSonnet = textOf('Plan.md').replace(/^model: .*$/m, 'model: claude-sonnet-5-5');
    expect(problems('Plan.md', planSonnet).join('\n')).toMatch(/该是完整 id claude-opus-5-5/);
  });

  it('【故意造出的失败】斥候带上 Edit 或 Write、拿掉禁用名单、设计能写：都查得出来', () => {
    const scout = textOf('Explore.md');
    const withEdit = scout.replace(
      /^disallowedTools: .*$/m,
      'disallowedTools: NotebookEdit\ntools: Read, Grep, Edit, Write',
    );
    expect(withEdit, '找不到 disallowedTools 那一行，这条失败造不出来').not.toBe(scout);
    const p = problems('Explore.md', withEdit);
    expect(p).toContain('Explore.md：只读的角色，disallowedTools 里要有 Edit');
    expect(p).toContain('Explore.md：只读的角色，disallowedTools 里要有 Write');
    expect(p).toContain('Explore.md：只读的角色，tools 里不许有 Edit');
    expect(p).toContain('Explore.md：只读的角色，tools 里不许有 Write');
    const noDeny = scout.replace(/^disallowedTools: .*\n/m, '');
    expect(noDeny).not.toBe(scout);
    expect(problems('Explore.md', noDeny)).toHaveLength(2);
    const plan = textOf('Plan.md');
    const planWrites = plan.replace(/^disallowedTools: .*$/m, 'disallowedTools: NotebookEdit');
    expect(planWrites).not.toBe(plan);
    expect(problems('Plan.md', planWrites)).toHaveLength(2);
  });

  it('【故意造出的失败】effort 改档、写上 isolation、斥候不限回合、认不出 frontmatter：都查得出来', () => {
    const scout = textOf('Explore.md');
    const low = scout.replace(/^effort: .*$/m, 'effort: low');
    expect(low).not.toBe(scout);
    expect(problems('Explore.md', low)).toEqual(['Explore.md：effort 是「low」，该是 medium']);
    const gp = textOf('general-purpose.md');
    const iso = gp.replace(/^model: (.*)$/m, 'model: $1\nisolation: worktree');
    expect(iso).not.toBe(gp);
    expect(problems('general-purpose.md', iso)).toEqual([
      'general-purpose.md：不许写 isolation（工作树由派活时选）',
    ]);
    const noTurns = scout.replace(/^maxTurns: .*\n/m, '');
    expect(noTurns).not.toBe(scout);
    expect(problems('Explore.md', noTurns)).toEqual(['Explore.md：要限 maxTurns']);
    const noOmit = gp.replace(/^omitClaudeMd: .*\n/m, '');
    expect(noOmit, '找不到 omitClaudeMd 那一行，这条失败造不出来').not.toBe(gp);
    expect(problems('general-purpose.md', noOmit)).toEqual(['general-purpose.md：要写 omitClaudeMd: true']);
    expect(() => problems('Plan.md', '没有 frontmatter')).toThrow(/认不出 frontmatter/);
  });

  it('【故意造出的失败】正文里写进每一个仓专属词：逐个查得出来', () => {
    const gp = textOf('general-purpose.md');
    for (const [label, , sample] of REPO_ONLY) {
      const bad = gp.replace('做法：', `做法：${sample}。`);
      expect(bad, '找不到「做法：」，这条失败造不出来').not.toBe(gp);
      expect(repoOnlyProblems('general-purpose.md', bad), label).toContain(
        `general-purpose.md：里面有仓专属的「${label}」`,
      );
    }
  });

  it('【故意造出的失败】同步名单多一份、少一份、认不出；引擎目录指回 .claude/agents、认不出：都查得出来', () => {
    const extra = TARGETS.replace("'Plan.md'", "'Plan.md', 'fleet-scout.md'");
    expect(extra, 'targets.ts 里找不到 Plan.md 那一项，这条失败造不出来').not.toBe(TARGETS);
    expect(syncFiles(extra)).not.toEqual(WANT_FILES);
    const dropped = TARGETS.replace(/'Plan\.md'/, '');
    expect(dropped).not.toBe(TARGETS);
    expect(syncFiles(dropped)).not.toEqual(WANT_FILES);
    expect(() => syncFiles(TARGETS.replace('export const SUBAGENT_TARGET', 'export const X'))).toThrow(
      /认不出 SUBAGENT_TARGET/,
    );
    expect(() => syncFiles('\nexport const SUBAGENT_TARGET = {\n  dir: x,\n};')).toThrow(/认不出 files/);
    const back = ADAPTER.replace("'../../../../agents/subagents'", "'../../../../.claude/agents'");
    expect(back, '找不到 SUBAGENTS_DIR 那一行，这条失败造不出来').not.toBe(ADAPTER);
    expect(engineDir(back)).toBe('.claude/agents');
    expect(() => engineDir('export const SUBAGENTS_DIR = "x";')).toThrow(/认不出 SUBAGENTS_DIR/);
  });
});
