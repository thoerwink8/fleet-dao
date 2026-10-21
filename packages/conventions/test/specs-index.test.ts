import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fsRepo } from '../src/repo.ts';
import {
  backfillStatus,
  checkSpecsIndex,
  generateSpecsIndex,
  headerLines,
  mainFile,
  readSpecs,
  SHARED_NUMBERS,
  SPECS_GENERATE_COMMAND,
  SPECS_INDEX_PATH,
  withStatusLine,
} from '../src/specs-index.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function spec(title: string, header: string[]): string {
  return [`# ${title}`, '', ...header, '', '## 正文', '', '- 状态：不是头部'].join('\n');
}

function problems(files: Record<string, string>): string[] {
  return readSpecs(memRepo(files)).problems.map((p) => p.text);
}

describe('方案主文件和头部', () => {
  it('主文件：需求.md 先，再方案.md，都没有取按码位排第一份 md；没有 md 是 undefined', () => {
    expect(mainFile(['方案.md', '结果.md', '需求.md'])).toBe('需求.md');
    expect(mainFile(['结果.md', '方案.md', 'a.json'])).toBe('方案.md');
    expect(mainFile(['点验.md', '最佳实践调研.md'])).toBe('最佳实践调研.md');
    expect(mainFile(['截图'])).toBeUndefined();
  });

  it('头部只认标题下连着的 - 行，正文里的不算', () => {
    expect(headerLines(spec('甲', ['- 状态：做完']))).toEqual(['- 状态：做完']);
    expect(headerLines('# 甲\n\n正文\n\n- 状态：做完\n')).toEqual([]);
    expect(headerLines('- 状态：在做\n\n正文\n')).toEqual(['- 状态：在做']);
  });
});

describe('方案索引生成', () => {
  const files = {
    'specs/12-甲/需求.md': spec('甲 | 一', ['- 状态：被取代', '- 被取代：specs/30-乙']),
    'specs/12-甲/方案.md': '# 不是主文件\n',
    'specs/30-乙/方案.md': spec('乙', ['- 状态：在做']),
    'specs/4-丙/需求.md': spec('丙', ['- 状态：未复核']),
    'specs/5-丁/截图/a.png': '',
    'specs/README.md': '',
  };

  it('按头部生成：分节、按编号数字排、被取代看得出来、只有附件的单列', () => {
    const { text = '', problems: p } = generateSpecsIndex(memRepo(files));
    expect(p).toEqual([]);
    expect(text).toContain('| [30-乙](<30-乙/方案.md>) | 乙 | 在做 | — |');
    expect(text).toContain('| [12-甲](<12-甲/需求.md>) | 甲 \\| 一 | 被取代 | [30-乙](<30-乙/>) |');
    expect(text.indexOf('4-丙/')).toBeLessThan(text.indexOf('30-乙/方案.md'));
    expect(text.indexOf('## 历史')).toBeLessThan(text.indexOf('12-甲/需求.md'));
    expect(text).toContain('- [5-丁](<5-丁/>)');
  });

  it('生成结果和仓里文件一致才过；不一致提示跑哪条命令', () => {
    const text = generateSpecsIndex(memRepo(files)).text ?? '';
    expect(checkSpecsIndex(memRepo({ ...files, [SPECS_INDEX_PATH]: text }))).toEqual([]);
    const stale = checkSpecsIndex(memRepo({ ...files, [SPECS_INDEX_PATH]: `${text}手改` }));
    expect(stale[0]?.text).toContain(SPECS_GENERATE_COMMAND);
  });

  it('头部缺状态报红', () => {
    const t = problems({ 'specs/1-a/需求.md': '# a\n\n正文\n\n- 状态：做完\n' });
    expect(t.some((x) => x.includes('1-a/需求.md') && x.includes('没写'))).toBe(true);
  });

  it('状态值不在清单里报红', () => {
    const t = problems({ 'specs/1-a/需求.md': spec('a', ['- 状态：生效']) });
    expect(t.some((x) => x.includes('「生效」'))).toBe(true);
  });

  it('被取代指向不存在的目录、指自己、写法不对、状态和那行对不上都报红', () => {
    const t = problems({
      'specs/1-a/需求.md': spec('a', ['- 状态：被取代', '- 被取代：specs/99-没有']),
      'specs/2-b/需求.md': spec('b', ['- 状态：被取代', '- 被取代：specs/2-b']),
      'specs/3-c/需求.md': spec('c', ['- 状态：被取代', '- 被取代：#5']),
      'specs/4-d/需求.md': spec('d', ['- 状态：被取代']),
      'specs/5-e/需求.md': spec('e', ['- 状态：做完', '- 被取代：specs/1-a']),
    });
    expect(t.some((x) => x.includes('specs/99-没有') && x.includes('不是仓里'))).toBe(true);
    expect(t.some((x) => x.includes('2-b') && x.includes('不能写自己'))).toBe(true);
    expect(t.some((x) => x.includes('3-c') && x.includes('「#5」'))).toBe(true);
    expect(t.some((x) => x.includes('4-d') && x.includes('要另带'))).toBe(true);
    expect(t.some((x) => x.includes('5-e') && x.includes('状态却是「做完」'))).toBe(true);
  });

  it('两个目录编号相同、都没标被取代报红；一个标了就过', () => {
    const both = problems({
      'specs/7-a/需求.md': spec('a', ['- 状态：做完']),
      'specs/7-b/方案.md': spec('b', ['- 状态：在做']),
    });
    expect(both.some((x) => x.includes('编号 7') && x.includes('7-a、7-b'))).toBe(true);
    const one = problems({
      'specs/7-a/需求.md': spec('a', ['- 状态：被取代', '- 被取代：specs/7-b']),
      'specs/7-b/方案.md': spec('b', ['- 状态：在做']),
    });
    expect(one).toEqual([]);
  });

  it('存量撞号名单只认写死的那几个目录，同号再来一个照样报红', () => {
    const [a, b] = SHARED_NUMBERS['902'] ?? [];
    const base = {
      [`specs/${a}/需求.md`]: spec('a', ['- 状态：做完']),
      [`specs/${b}/需求.md`]: spec('b', ['- 状态：做完']),
    };
    expect(problems(base)).toEqual([]);
    expect(problems({ ...base, 'specs/902-新的/需求.md': spec('c', ['- 状态：在做']) })).toHaveLength(1);
  });

  it('目录名不是「编号-短名」报红；读不到目录是没查成', () => {
    expect(problems({ 'specs/草稿/需求.md': spec('a', ['- 状态：做完']) })[0]).toContain('<编号>-<短名>');
    expect(checkSpecsIndex(memRepo({}))[0]?.notQueried).toBe(true);
  });
});

describe('存量回填', () => {
  it('单关了做完、开着在做、对不上未复核', () => {
    expect(backfillStatus({ state: 'closed' })).toBe('做完');
    expect(backfillStatus({ state: 'open' })).toBe('在做');
    expect(backfillStatus(undefined)).toBe('未复核');
  });

  it('只新增行：标题下空行、标题下直接是正文、没有标题三种；已有状态不动', () => {
    expect(withStatusLine('# 甲\n\n正文\n', '做完')).toBe('# 甲\n\n- 状态：做完\n\n正文\n');
    expect(withStatusLine('# 甲\n> 引用\n', '在做')).toBe('# 甲\n\n- 状态：在做\n\n> 引用\n');
    expect(withStatusLine('正文\n', '未复核')).toBe('- 状态：未复核\n\n正文\n');
    expect(withStatusLine('# 甲\n\n- 母单 #1\n', '做完')).toBe('# 甲\n\n- 状态：做完\n\n- 母单 #1\n');
    expect(withStatusLine('# 甲\n\n- 状态：在做\n', '做完')).toBeUndefined();
  });
});

describe('真仓', () => {
  it('specs/README.md 和各目录主文件头部生成的一致', () => {
    expect(checkSpecsIndex(fsRepo(ROOT)).map((p) => p.text)).toEqual([]);
  });

  it('存量撞号名单里的目录都还在（删了就从名单里去掉）', () => {
    const repo = fsRepo(ROOT);
    for (const dirs of Object.values(SHARED_NUMBERS)) {
      for (const d of dirs) expect(repo.isDir(`specs/${d}`), d).toBe(true);
    }
  });
});
