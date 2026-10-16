// 钉住子代理规范只有一份出处：agents/subagents/README.md（决定 0102 记来历，README 写现在怎么做）。
// 改标准：改这个文件要创始人同意（packages/conventions/standard-paths.json 的 agents/test/rules/）。
// 钉这几件：
// 1. README 里「三个角色」表写的型号、effort 和 agents/subagents/ 下三份定义的 frontmatter 对得上（改一边不改另一边就红）。
// 2. README 写全护栏三条：一次没过换 Sonnet；返工率超过 20%（样本不少于 5）或一次错进 PR 就收回放宽；复查日期。
// 3. README 里写了派工时 model 怎么写（只认小写别名 haiku、sonnet、opus；定义里写完整 id），且不再有别名升档的写法。
// 4. 通用段（shared-rules.md）留一句完整的短规矩，用到的写法 README 里都有，不另造；不指向「见某文件」就完事。
// 5. 指挥官技能里没有划线全文的第二份，只指向 README，也没有「斥候 "sonnet"、工人 "opus"」这种别名升档。
// 不钉措辞，钉的是「有没有、对不对得上、有没有第二份」。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8').replace(/\r\n/g, '\n');

const README = read('agents/subagents/README.md');
const SKILL = read('agents/skills/commander/SKILL.md');
const SHARED = read('agents/shared-rules.md');
const ROLES = ['Explore', 'general-purpose', 'Plan'] as const;
const DEFS: Record<string, string> = Object.fromEntries(
  ROLES.map((r) => [r, read(`agents/subagents/${r}.md`)]),
);

const frontmatter = (text: string, key: string) =>
  new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '')?.[1]?.trim();

/** README「三个角色」表的行：| `角色` | `型号` | effort | … 。认不出的行不算 */
function roleRows(readme: string): Map<string, { model: string; effort: string }> {
  const out = new Map<string, { model: string; effort: string }>();
  for (const line of readme.split('\n')) {
    const m = /^\|\s*`([A-Za-z-]+)`[^|]*\|\s*`([^`]+)`\s*\|\s*([a-z]+)\s*\|/.exec(line);
    if (m?.[1] !== undefined) out.set(m[1], { model: m[2] ?? '', effort: m[3] ?? '' });
  }
  return out;
}

/** README 和三份定义对不上的地方；空数组才算对 */
function tierProblems(readme: string, defs: Record<string, string>): string[] {
  const out: string[] = [];
  const rows = roleRows(readme);
  for (const role of ROLES) {
    const row = rows.get(role);
    if (!row) {
      out.push(`README 的三个角色表里没有 ${role} 这一行`);
      continue;
    }
    const model = frontmatter(defs[role] ?? '', 'model');
    const effort = frontmatter(defs[role] ?? '', 'effort');
    if (row.model !== model) out.push(`${role}：README 写 ${row.model}，定义里是 ${model ?? '没写'}`);
    if (row.effort !== effort)
      out.push(`${role}：README 写 effort ${row.effort}，定义里是 ${effort ?? '没写'}`);
  }
  for (const name of rows.keys())
    if (!(ROLES as readonly string[]).includes(name)) out.push(`表里多了角色 ${name}`);
  return out;
}

/** 护栏三条各认什么；README 里缺哪条就报哪条 */
const GUARDS: ReadonlyArray<readonly [string, RegExp[]]> = [
  ['一次没过就换 Sonnet', [/一次没过/, /换\s*Sonnet/]],
  [
    '返工率超过 20%（样本不少于 5）或一次错进 PR 就收回放宽',
    [/返工率/, /20%/, /不少于\s*5/, /错进了?\s*PR/, /收回/],
  ],
  ['复查日期 2026-11-12', [/2026-11-12/, /复查/]],
];

function guardProblems(readme: string): string[] {
  const out: string[] = [];
  const at = readme.indexOf('## 护栏');
  if (at < 0) return ['README 里没有「## 护栏」一节'];
  const rest = readme.slice(at + 1);
  const next = rest.search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next);
  for (const [name, res] of GUARDS) {
    const missing = res.filter((re) => !re.test(section));
    if (missing.length > 0) out.push(`护栏缺「${name}」（没找到 ${missing.map(String).join('、')}）`);
  }
  return out;
}

/** 派工时 model 怎么写：README 要有这一节、写明别名落到哪个型号，不许再出现别名升档 */
function modelWritingProblems(readme: string): string[] {
  const out: string[] = [];
  const at = readme.indexOf('## 派工时 model 怎么写');
  if (at < 0) return ['README 里没有「## 派工时 model 怎么写」一节'];
  const rest = readme.slice(at + 1);
  const next = rest.search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next);
  for (const [alias, id] of [
    ['haiku', 'claude-haiku-5-5'],
    ['sonnet', 'claude-sonnet-5-5'],
    ['opus', 'claude-opus-5-5'],
  ] as const) {
    if (!section.includes(`\`${alias}\``) || !section.includes(id))
      out.push(`model 一节没写别名 ${alias} 落到 ${id}`);
  }
  return out;
}

const ALIAS_ESCALATION = /(斥候|工人)[^\n]{0,6}`?"(sonnet|opus)"`?/;
/** 通用段的毛病：短规矩要完整（三个角色、降档的写法、三条缺一不可里的三件、指向 README），写法 README 里都要有 */
function sharedProblems(shared: string, readme: string): string[] {
  const out: string[] = [];
  const line = shared.split('\n').find((l) => l.includes('子代理只用'));
  if (line === undefined) return ['通用段里找不到「子代理只用……」那句短规矩'];
  for (const role of ROLES) if (!line.includes(`\`${role}\``)) out.push(`短规矩里没写角色 ${role}`);
  for (const w of ['窄', '机器核对', '规矩写全']) if (!line.includes(w)) out.push(`短规矩里没写「${w}」`);
  if (!line.includes('model: "haiku"')) out.push('短规矩里没写降档用 model: "haiku"');
  if (!line.includes('agents/subagents/README.md')) out.push('短规矩里没指向 agents/subagents/README.md');
  if (ALIAS_ESCALATION.test(line)) out.push('短规矩里有别名升档的写法');
  for (const m of line.matchAll(/model:\s*"([a-z]+)"/g))
    if (!readme.includes(`model: "${m[1]}"`)) out.push(`短规矩用了 model: "${m[1]}"，README 里没有`);
  if (/Fable/.test(line) && !/Fable/.test(readme)) out.push('短规矩提了 Fable，README 里没提');
  return out;
}

/** 技能里不许有的：划线全文的第二份、别名升档；要有的：指向 README */
const SECOND_COPY: ReadonlyArray<readonly [string, RegExp]> = [
  ['缺一不可那一段', /缺一不可/],
  ['「放心给 Haiku」那一条', /放心给\s*Haiku/],
  ['「仍给 Sonnet」那一条', /仍给\s*Sonnet/],
  ['返工率护栏', /返工率/],
  ['复查日期', /2026-11-12/],
  ['别名升档', ALIAS_ESCALATION],
];
function skillProblems(skill: string): string[] {
  const out: string[] = [];
  for (const [name, re] of SECOND_COPY) if (re.test(skill)) out.push(`技能里有划线的第二份：${name}`);
  if (!skill.includes('agents/subagents/README.md')) out.push('技能里没指向 agents/subagents/README.md');
  return out;
}

describe('规矩：子代理规范只有 agents/subagents/README.md 一份出处', () => {
  it('README 的三个角色表和三份定义的 model、effort 对得上', () => {
    expect(tierProblems(README, DEFS)).toEqual([]);
  });

  it('README 写全护栏三条', () => {
    expect(guardProblems(README)).toEqual([]);
  });

  it('README 写明派工时 model 怎么写、别名落到哪个型号', () => {
    expect(modelWritingProblems(README)).toEqual([]);
  });

  it('通用段留着一句完整的短规矩，和 README 不矛盾', () => {
    expect(sharedProblems(SHARED, README)).toEqual([]);
  });

  it('指挥官技能只指向 README：没有划线全文的第二份，没有别名升档', () => {
    expect(skillProblems(SKILL)).toEqual([]);
  });

  it('【故意造出的失败】README 里的型号、effort 改了、少一行、多一行：都查得出来', () => {
    const bad = README.replace('`claude-haiku-5-5`', '`claude-haiku-4-5`');
    expect(bad).not.toBe(README);
    expect(tierProblems(bad, DEFS)).toHaveLength(1);
    const lines = README.split('\n');
    const gone = lines.filter((l) => !/^\|\s*`Plan`/.test(l)).join('\n');
    expect(gone).not.toBe(README);
    expect(tierProblems(gone, DEFS)).toEqual(['README 的三个角色表里没有 Plan 这一行']);
    expect(
      tierProblems(`${README}\n| \`fleet-scout\` | \`claude-haiku-5-5\` | medium | x |\n`, DEFS),
    ).toEqual(['表里多了角色 fleet-scout']);
    const lowered = DEFS.Plan?.replace(/^effort:.*$/m, 'effort: low') ?? '';
    expect(tierProblems(README, { ...DEFS, Plan: lowered })).toHaveLength(1);
  });

  it('【故意造出的失败】护栏三条各拿掉一条：每条都查得出来', () => {
    expect(guardProblems(README.replace(/20%/g, '三成'))).toHaveLength(1);
    expect(guardProblems(README.replace(/2026-11-12/g, '以后'))).toHaveLength(1);
    expect(guardProblems(README.replace(/一次没过/g, '一次不行'))).toHaveLength(1);
    expect(guardProblems(README.replace(/错进了?\s*PR/g, '出了事'))).toHaveLength(1);
    expect(guardProblems(README.replace('## 护栏', '## 别的'))).toEqual(['README 里没有「## 护栏」一节']);
  });

  it('【故意造出的失败】model 一节删了别名落点：查得出来', () => {
    expect(modelWritingProblems(README.replaceAll('claude-opus-5-5', 'opus 新版'))).toHaveLength(1);
    expect(modelWritingProblems(README.replace('## 派工时 model 怎么写', '## 别的'))).toHaveLength(1);
  });

  it('【故意造出的失败】通用段只写「见某文件」、写回别名升档、用了 README 没有的写法：都查得出来', () => {
    const line = SHARED.split('\n').find((l) => l.includes('子代理只用')) ?? '';
    expect(line).not.toBe('');
    const onlySee = SHARED.replace(line, '- 子代理只用三个角色，见 agents/subagents/README.md。');
    expect(sharedProblems(onlySee, README).length).toBeGreaterThan(0);
    const alias = SHARED.replace(line, `${line} 斥候 \`"sonnet"\`、工人 \`"opus"\`。`);
    expect(sharedProblems(alias, README)).toContain('短规矩里有别名升档的写法');
    const unknown = SHARED.replace(line, `${line} 也可传 model: "inherit"。`);
    expect(sharedProblems(unknown, README)).toEqual(['短规矩用了 model: "inherit"，README 里没有']);
    expect(sharedProblems(SHARED.replace('子代理只用', '别的只用'), README)).toHaveLength(1);
  });

  it('【故意造出的失败】技能里抄回划线全文、别名升档、删掉指向 README：都查得出来', () => {
    expect(skillProblems(`${SKILL}\n- 窄改动编码给工人传 model: "haiku"，三条缺一不可：\n`)).toEqual([
      '技能里有划线的第二份：缺一不可那一段',
    ]);
    expect(skillProblems(`${SKILL}\n- 放心给 Haiku：读码\n- 仍给 Sonnet：跨包\n`)).toHaveLength(2);
    expect(skillProblems(`${SKILL}\n难的才升档（斥候 \`"sonnet"\`、工人 \`"opus"\`）\n`)).toEqual([
      '技能里有划线的第二份：别名升档',
    ]);
    expect(skillProblems(SKILL.replaceAll('agents/subagents/README.md', 'x'))).toEqual([
      '技能里没指向 agents/subagents/README.md',
    ]);
    expect(skillProblems(`${SKILL}\n返工率超过 20% 就收回；2026-11-12 复查\n`)).toHaveLength(2);
  });
});
