import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fsRepo } from '../src/repo.ts';
import {
  backfillStatus,
  checkSpecsIndex,
  generateSpecsIndex,
  headerLines,
  mainFile,
  planBackfill,
  readSpecs,
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

  it('主文件：讨论稿.md 排在需求.md、方案.md 前面（决定 0118）', () => {
    expect(mainFile(['方案.md', '需求.md', '讨论稿.md', '落地.md'])).toBe('讨论稿.md');
    expect(mainFile(['落地.md', '讨论稿.md'])).toBe('讨论稿.md');
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

  it('讨论稿的状态值：去掉注释和括号说明再按开头认；七个词都认，旧值照过', () => {
    for (const value of [
      '讨论中 <!-- 讨论中 / 已定（YYYY-MM-DD，见 [决定](…)）/ 搁置 -->',
      '已定（2026-10-24，见 [决定](../../docs/decisions/0118-x.md)）',
      '  在做  ',
      '做完（2026-11-01）',
      '搁置（等平台升级再看）',
      '未复核',
    ]) {
      expect(problems({ 'specs/1-a/讨论稿.md': spec('a', [`- 状态：${value}`]) }), value).toEqual([]);
    }
    expect(
      problems({
        'specs/1-a/讨论稿.md': spec('a', ['- 状态：被取代（见 30）', '- 被取代：specs/30-b']),
        'specs/30-b/方案.md': spec('b', ['- 状态：在做']),
      }),
    ).toEqual([]);
    expect(problems({ 'specs/1-a/讨论稿.md': spec('a', ['- 状态：随便写']) })[0]).toContain('「随便写」');
  });

  it('讨论中 / 已定 / 搁置只许写在讨论稿.md；方案.md、需求.md 写了报红', () => {
    for (const status of ['讨论中', '已定', '搁置']) {
      for (const file of ['方案.md', '需求.md']) {
        const t = problems({ [`specs/1-a/${file}`]: spec('a', [`- 状态：${status}`]) });
        expect(t, `${file} ${status}`).toHaveLength(1);
        expect(t[0]).toContain('只许写在 讨论稿.md');
      }
    }
    for (const status of ['在做', '做完', '未复核'])
      expect(problems({ 'specs/1-a/方案.md': spec('a', [`- 状态：${status}`]) })).toEqual([]);
  });

  it('讨论稿和旧方案同目录：只认讨论稿，旧文件的状态行不核对', () => {
    const files = {
      'specs/1-a/讨论稿.md': spec('a', ['- 状态：已定（2026-10-24）']),
      'specs/1-a/需求.md': '# 旧\n\n- 状态：乱写\n',
    };
    expect(problems(files)).toEqual([]);
    expect(readSpecs(memRepo(files)).entries[0]?.file).toBe('讨论稿.md');
  });

  it('索引分节：讨论中、已定、在做、未复核在「还在管事」，做完、搁置、被取代进「历史」', () => {
    const files = {
      'specs/1-a/讨论稿.md': spec('甲', ['- 状态：讨论中']),
      'specs/2-b/讨论稿.md': spec('乙', ['- 状态：已定（2026-10-24）']),
      'specs/3-c/方案.md': spec('丙', ['- 状态：在做']),
      'specs/4-d/方案.md': spec('丁', ['- 状态：未复核']),
      'specs/5-e/讨论稿.md': spec('戊', ['- 状态：搁置（等一等）']),
      'specs/6-f/方案.md': spec('己', ['- 状态：做完']),
      'specs/7-g/方案.md': spec('庚', ['- 状态：被取代', '- 被取代：specs/3-c']),
    };
    const { text = '' } = generateSpecsIndex(memRepo(files));
    const history = text.indexOf('## 历史');
    for (const d of ['1-a/', '2-b/', '3-c/', '4-d/']) expect(text.indexOf(d)).toBeLessThan(history);
    for (const d of ['5-e/', '6-f/', '7-g/']) expect(text.indexOf(d)).toBeGreaterThan(history);
    expect(text).toContain('| 已定 |');
    expect(text).toContain('| 搁置 |');
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

  it('没有撞号白名单：两个 902- 目录都没标被取代照样报红，三个同号报三个目录', () => {
    const base = {
      'specs/902-驾驶舱用户视角e2e/缺陷清单.md': spec('a', ['- 状态：做完']),
      'specs/902-驾驶舱首页流程图/方案.md': spec('b', ['- 状态：做完']),
    };
    const two = problems(base);
    expect(two).toHaveLength(1);
    expect(two[0]).toContain('编号 902');
    const three = problems({ ...base, 'specs/902-新的/需求.md': spec('c', ['- 状态：在做']) });
    expect(three).toHaveLength(1);
    expect(three[0]).toContain('有 3 个目录');
  });

  it('子编号：555-2-x 和 555-y 不是同一个编号；同是 555-2 照样报红；排序 555 在 555-2 前', () => {
    const files = {
      'specs/555-验收/需求.md': spec('验收', ['- 状态：做完']),
      'specs/555-2-冷调用/需求.md': spec('冷调用', ['- 状态：做完']),
      'specs/598-555-4-x/需求.md': spec('x', ['- 状态：做完']),
    };
    expect(problems(files)).toEqual([]);
    const { text = '' } = generateSpecsIndex(memRepo(files));
    expect(text.indexOf('555-验收/')).toBeLessThan(text.indexOf('555-2-冷调用/'));
    expect(text.indexOf('555-2-冷调用/')).toBeLessThan(text.indexOf('598-555-4-x/'));
    expect(problems({ ...files, 'specs/555-2-另一个/需求.md': spec('另', ['- 状态：在做']) })[0]).toContain(
      '编号 555-2',
    );
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

  const repo = memRepo({
    'specs/1-关了/需求.md': '# 关了\n\n正文\n',
    'specs/2-开着/需求.md': '# 开着\n\n正文\n',
    'specs/3-对不上/方案.md': '# 对不上\n\n正文\n',
    'specs/4-已有/需求.md': spec('已有', ['- 状态：做完']),
    'specs/555-2-子编号/需求.md': '# 子编号\n\n正文\n',
    'specs/6-只有附件/截图/a.png': '',
  });

  it('planBackfill：按单的开关给状态，已有状态、只有附件的不动；不猜被取代', () => {
    const { changes, problems: p } = planBackfill(
      repo,
      new Map([
        [1, 'closed'],
        [2, 'open'],
        [555, 'closed'],
      ]),
    );
    expect(p).toEqual([]);
    expect(changes.map((c) => [c.dir, c.status])).toEqual([
      ['1-关了', '做完'],
      ['2-开着', '在做'],
      ['3-对不上', '未复核'],
      ['555-2-子编号', '做完'],
    ]);
    expect(changes[0]?.next).toBe('# 关了\n\n- 状态：做完\n\n正文\n');
  });

  it('读不到单的状态（states 是 undefined）：每份都回填「未复核」，不整批放弃', () => {
    const { changes, problems: p } = planBackfill(repo, undefined);
    expect(p).toEqual([]);
    expect(changes.map((c) => c.status)).toEqual(['未复核', '未复核', '未复核', '未复核']);
    expect(changes.every((c) => c.why.includes('读不到单的状态'))).toBe(true);
  });

  it('读不到某份主文件：记没查成，别的照回填，不静默跳过', () => {
    const files = {
      'specs/1-好/需求.md': '# 好\n\n正文\n',
      'specs/2-坏/需求.md': '# 坏\n\n正文\n',
    };
    const base = memRepo(files);
    const broken: typeof base = {
      ...base,
      read: (p: string) => (p === 'specs/2-坏/需求.md' ? undefined : base.read(p)),
    };
    const { changes, problems: p } = planBackfill(broken, new Map());
    expect(changes.map((c) => c.dir)).toEqual(['1-好']);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('没查成');
    expect(p[0]).toContain('specs/2-坏/需求.md');
    expect(planBackfill(memRepo({}), new Map()).problems[0]).toContain('没查成');
  });
});

describe('真仓', () => {
  it('specs/README.md 和各目录主文件头部生成的一致', () => {
    expect(checkSpecsIndex(fsRepo(ROOT)).map((p) => p.text)).toEqual([]);
  });

  it('没有两个目录共用一个编号（被取代的除外）：真仓不靠白名单', () => {
    const { entries } = readSpecs(fsRepo(ROOT));
    const seen = new Map<string, string>();
    for (const e of entries.filter((x) => x.status !== '被取代')) {
      expect(seen.get(e.number), `${e.number} 重复：${e.dir}`).toBeUndefined();
      seen.set(e.number, e.dir);
    }
  });
});
