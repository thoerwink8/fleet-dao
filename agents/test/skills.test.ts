// agents/skills 里写的指针必须都指得到：仓内路径、文档章节、设计文档「第 N 条」、同目录附件、别的 skill 的名字。
// 落点被挪走或改名，这里当场红——指向空气的指针比没有更糟。
// 另守两条会慢慢变坏的：name 和目录同名（按目录分发）；description 不超过 120 字（每个会话都为它付费）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS = join(ROOT, 'agents', 'skills');
const MAX_DESCRIPTION = 120;
/** 正文里用反引号写、长得像 skill 名、其实不是的词（例子里的链名）。 */
const NOT_SKILLS = new Set(['job-lock']);

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const skillNames = readdirSync(SKILLS)
  .filter((name) => statSync(join(SKILLS, name)).isDirectory())
  .sort();
const files = [join(SKILLS, 'README.md'), ...skillNames.map((name) => join(SKILLS, name, 'SKILL.md'))];
const texts = files.map((file) => ({
  file: file.slice(ROOT.length).replace(/\\/g, '/'),
  dir: dirname(file),
  text: read(file),
}));

function matches(re: RegExp): { file: string; dir: string; groups: string[] }[] {
  return texts.flatMap(({ file, dir, text }) =>
    [...text.matchAll(re)].map((m) => ({ file, dir, groups: m.slice(1) })),
  );
}

/** 标题行的级别（# 的个数）；不是标题（含代码块里以 # 开头的注释行）就是 0。 */
function headingLevels(lines: string[]): number[] {
  let fenced = false;
  return lines.map((line) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6}) /.exec(line);
    return m?.[1]?.length ?? 0;
  });
}

/** 一篇文档里标题为 title 的那一节（到下一个同级或更高的标题为止）；没有这个标题就是 undefined。 */
function section(doc: string, title: string): string | undefined {
  const lines = read(join(ROOT, doc)).split('\n');
  const levels = headingLevels(lines);
  const start = lines.findIndex(
    (line, i) => (levels[i] ?? 0) > 0 && line.replace(/^#+ /, '').trim() === title,
  );
  if (start < 0) return undefined;
  const level = levels[start] ?? 0;
  const end = levels.findIndex((l, i) => i > start && l > 0 && l <= level);
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  return Object.fromEntries(
    block.split('\n').flatMap((line) => {
      const kv = /^([a-z-]+): (.+)$/.exec(line);
      return kv ? [[kv[1], kv[2]]] : [];
    }),
  );
}

describe('agents/skills 的指针', () => {
  it('找得到 skill 目录', () => {
    expect(skillNames.length).toBeGreaterThan(0);
  });

  // 每一类先断言「找到了至少一处」：正则认不出了，和「全都指得到」看起来一样是绿的，得分开。
  // 某一类指针真的都删光了，就连这一条一起删。
  it('反引号里的仓内路径都存在', () => {
    const paths = matches(/`((?:packages|docs|agents)\/[^`\s]+)`/g);
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter(({ groups: [path] }) => !existsSync(join(ROOT, path ?? '')));
    expect(missing.map(({ file, groups: [path] }) => `${file} → ${path}`)).toEqual([]);
  });

  it('「路径」「章节」指的章节都在', () => {
    const refs = matches(/`((?:packages|docs)\/[^`\s]+\.md)`「([^」]+)」/g);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter(({ groups: [doc, title] }) => section(doc ?? '', title ?? '') === undefined);
    expect(missing.map(({ file, groups: [doc, title] }) => `${file} → ${doc}「${title}」`)).toEqual([]);
  });

  it('「章节」第 N 条指的那一行在那一节的表里', () => {
    const refs = matches(/`((?:packages|docs)\/[^`\s]+\.md)`「([^」]+)」第 (\d+) 条/g);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter(({ groups: [doc, title, n] }) => {
      const body = section(doc ?? '', title ?? '') ?? '';
      return !new RegExp(`^\\| *${n} *\\|`, 'm').test(body);
    });
    expect(
      missing.map(({ file, groups: [doc, title, n] }) => `${file} → ${doc}「${title}」第 ${n} 条`),
    ).toEqual([]);
  });

  it('README 指的设计第 16 条确实在讲 skill 由同步脚本分发', () => {
    const body = section('docs/design.md', '三、已定（共识）') ?? '';
    const row = body.split('\n').find((line) => /^\| *16 *\|/.test(line)) ?? '';
    expect(read(join(SKILLS, 'README.md'))).toContain('`docs/design.md`「三、已定（共识）」第 16 条');
    // 同一句里先说 skill、再说同步脚本：这一行前半句讲 AGENTS.md 时也提同步脚本，分开查两个词查不出 skill 那句被改掉。
    expect(row).toMatch(/skill[^。；|]*同步脚本/);
  });

  it('「同目录 `文件`」指的附件都在', () => {
    const refs = matches(/同目录 `([^`]+)`/g);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter(({ dir, groups: [name] }) => !existsSync(join(dir, name ?? '')));
    expect(missing.map(({ file, groups: [name] }) => `${file} → ${name}`)).toEqual([]);
  });

  it('反引号里提到的别的 skill 都在', () => {
    const refs = matches(/`([a-z]+(?:-[a-z]+)+)`/g).filter(
      ({ groups: [name] }) => !NOT_SKILLS.has(name ?? ''),
    );
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter(({ groups: [name] }) => !skillNames.includes(name ?? ''));
    expect(missing.map(({ file, groups: [name] }) => `${file} → ${name}`)).toEqual([]);
  });
});

describe.each(skillNames)('%s 的 frontmatter', (name) => {
  const meta = frontmatter(read(join(SKILLS, name, 'SKILL.md')));

  it('name 和目录同名', () => {
    expect(meta.name).toBe(name);
  });

  it(`description 有，且不超过 ${MAX_DESCRIPTION} 字`, () => {
    const length = [...(meta.description ?? '')].length;
    expect(length).toBeGreaterThan(0);
    expect(length).toBeLessThanOrEqual(MAX_DESCRIPTION);
  });
});
