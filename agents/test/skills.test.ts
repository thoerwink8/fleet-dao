// agents/skills 里写的指针必须都指得到：仓内路径、文档章节、设计文档「第 N 条」、同目录附件、别的 skill 的名字。
// 路径和 skill 名一律写在反引号里（行内代码或代码块）：写在外面的认不出是指针、查不了它指向哪，所以直接判红。
// 落点被挪走或改名，这里当场红——指向空气的指针比没有更糟。
// 另守两条会慢慢变坏的：name 和目录同名（按目录分发）；description 不超过 120 字（每个会话都为它付费）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS = join(ROOT, 'agents', 'skills');
const MAX_DESCRIPTION = 120;
/** 长得像 skill 名（小写字母、数字加连字符）、其实不是的词：仓名、英文原文里的普通词、例子里的链名。 */
const NOT_SKILLS = new Set(['fleet-dao', 'sub-agent', 'job-lock']);

/** 紧挨着这些字的不算一个词的开头（只看 ASCII：中文和英文之间常不留空格）。 */
const EDGE = '[A-Za-z0-9_.~/-]';
/** 路径里会出现的字，含中文目录名和 <占位>；遇到空白和中文标点就断。 */
const PATH_CHAR = '[\\p{L}\\p{N}_.~/<>@+-]';
/** 以仓根下这几个目录开头的，当仓内路径查存在。 */
const REPO_PATH = new RegExp(
  `(?<!${EDGE})(?:packages|docs|agents|deploy|specs|\\.github)/${PATH_CHAR}*`,
  'gu',
);
/** 反引号外面像路径的：仓内路径、~/ ./ ../ 开头、两个以上斜杠、带常见扩展名的文件名。只有一个斜杠的（if/else、owner/repo）不算。 */
const PATH_LIKE = [
  REPO_PATH,
  new RegExp(`(?<!${EDGE})(?:~|\\.{1,2})/${PATH_CHAR}*`, 'gu'),
  new RegExp(`(?<!${EDGE})[\\w.~-]*/[\\w.~-]+/[\\w.~/-]*`, 'gu'),
  /(?<![\p{L}\p{N}_.~/-])[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.(?:md|ts|tsx|mjs|json|txt|sh|ya?ml|toml|env)(?![\p{L}\p{N}_.~/-])/gu,
];
const KEBAB = '[a-z][a-z0-9]*(?:-[a-z0-9]+)+';
/** 句末的英文句点不算连在词上；后面跟着扩展名的（grill-me.md）归文件名那条管。 */
const SKILL_LIKE = new RegExp(`(?<!${EDGE})${KEBAB}(?![A-Za-z0-9_~/-]|\\.[A-Za-z0-9])`, 'g');
const WHOLE_KEBAB = new RegExp(`^${KEBAB}$`);

interface Parts {
  /** 反引号里的：每段行内代码、每个代码块各一条。 */
  code: string[];
  /** 反引号外面的正文，网址去掉了；frontmatter 只留 description 的值。 */
  prose: string;
  /** 有没合上的代码块：后面的正文会全被当成代码，查不到。 */
  unclosedFence: boolean;
}

function split(text: string): Parts {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const code: string[] = [];
  /** 一行里的行内代码收进 code，原处换成空格，剩下的是正文。description 也走这里。 */
  const outside = (line: string) =>
    line.replace(/`([^`\n]+)`/g, (_span, inner: string) => {
      code.push(inner);
      return ' ';
    });
  const prose: string[] = [outside(/^description: (.*)$/m.exec(fm?.[1] ?? '')?.[1] ?? '')];
  let fence: string[] | undefined;
  for (const line of (fm ? text.slice(fm[0].length) : text).split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      if (fence) code.push(fence.join('\n'));
      fence = fence ? undefined : [];
    } else if (fence) {
      fence.push(line);
    } else {
      prose.push(outside(line));
    }
  }
  if (fence) code.push(fence.join('\n'));
  return {
    code,
    prose: prose.join('\n').replace(/https?:\/\/[^\s)>）]+/g, ' '),
    unclosedFence: fence !== undefined,
  };
}

/** 反引号外面像路径、像 skill 名的词（白名单里的不算）。 */
function strays(prose: string): string[] {
  const paths = PATH_LIKE.flatMap((re) => [...prose.matchAll(re)].map((m) => m[0]));
  const names = [...prose.matchAll(SKILL_LIKE)].map((m) => m[0]).filter((w) => !NOT_SKILLS.has(w));
  return [...new Set([...paths, ...names])];
}

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const skillNames = readdirSync(SKILLS)
  .filter((name) => statSync(join(SKILLS, name)).isDirectory())
  .sort();
const files = [join(SKILLS, 'README.md'), ...skillNames.map((name) => join(SKILLS, name, 'SKILL.md'))];
const texts = files.map((file) => {
  const text = read(file);
  return { file: file.slice(ROOT.length).replace(/\\/g, '/'), dir: dirname(file), text, ...split(text) };
});

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
  it('找得到 skill 目录，每篇都拆得出正文、代码块都合上了', () => {
    expect(skillNames.length).toBeGreaterThan(0);
    // 正文拆空了，下一条「写在反引号里」会假绿。
    expect(texts.filter(({ prose }) => prose.trim() === '').map(({ file }) => file)).toEqual([]);
    expect(texts.filter(({ unclosedFence }) => unclosedFence).map(({ file }) => file)).toEqual([]);
  });

  it('路径和 skill 名都写在反引号里', () => {
    const found = texts.flatMap(({ file, prose }) => strays(prose).map((word) => `${file} → ${word}`));
    expect(found).toEqual([]);
  });

  // 每一类先断言「找到了至少一处」：正则认不出了，和「全都指得到」看起来一样是绿的，得分开。
  // 某一类指针真的都删光了，就连这一条一起删。
  it('反引号里的仓内路径都存在', () => {
    const paths = texts.flatMap(({ file, code }) =>
      code.flatMap((c) => [...c.matchAll(REPO_PATH)].map((m) => ({ file, path: m[0].replace(/\.+$/, '') }))),
    );
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter(({ path }) => !existsSync(join(ROOT, path)));
    expect(missing.map(({ file, path }) => `${file} → ${path}`)).toEqual([]);
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
    const refs = texts.flatMap(({ file, code }) =>
      code.filter((c) => WHOLE_KEBAB.test(c) && !NOT_SKILLS.has(c)).map((name) => ({ file, name })),
    );
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter(({ name }) => !skillNames.includes(name));
    expect(missing.map(({ file, name }) => `${file} → ${name}`)).toEqual([]);
  });
});

// 上面「写在反引号里」那条是否认得出违规：每种写法故意造一次，必须查出来；不该算的也逐样列出，必须放过。
describe('反引号外面的检查认得出违规', () => {
  it.each([
    '见 docs/design.md',
    '见specs/30-规矩同步/需求.md。',
    '装在 ~/.local/bin',
    '在 /srv/fleet-dao/current 下',
    '默认遵守 robots.txt，',
    '先 grill-ai：',
    '读plain-board。',
    'read grill-me.',
  ])('认得出「%s」', (sample) => {
    expect(strays(split(sample).prose)).not.toEqual([]);
  });

  it('frontmatter 里只查 description，description 里的反引号照样算数', () => {
    const bare = split('---\nname: grill-ai\ndescription: 或 chain-first 转来时读。\n---\n\n正文。\n');
    expect(strays(bare.prose)).toEqual(['chain-first']);
    const quoted = split('---\nname: grill-ai\ndescription: 或 `chain-first` 转来时读。\n---\n\n正文。\n');
    expect(strays(quoted.prose)).toEqual([]);
    expect(quoted.code).toEqual(['chain-first']);
  });

  it('反引号里的、代码块里的、网址里的、只有一个斜杠的、白名单里的都放过', () => {
    const sample = [
      '读 `grill-ai`，见 `docs/design.md`「三、已定（共识）」；if/else、owner/repo、是/否、0.25–0.8。',
      '见 <https://example.com/rule-based-x/y/z>、[a/b](https://example.com/c/d)；fleet-dao 仓；a sub-agent。',
      '```',
      'node docs/x.ts grill-me ~/.local/bin',
      '```',
    ].join('\n');
    expect(strays(split(sample).prose)).toEqual([]);
  });

  it('代码块没合上：认得出来', () => {
    expect(split('正文\n```\nnode docs/x.ts\n').unclosedFence).toBe(true);
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
