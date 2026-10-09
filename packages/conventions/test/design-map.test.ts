// design 对照清单的测试（#139 这一片）：全用内存假仓，不读盘上的 docs/design/map.json。
import { describe, expect, it } from 'vitest';
import { checkDesignMap, DESIGN_MAP_PATH, readDesignMap } from '../src/design-map.ts';
import { memRepo } from './helpers.ts';

const PKG = 'packages/conventions/src/index.ts';

function designOf(name: string): string {
  return `docs/design/${name}.md`;
}

describe('design 对照清单', () => {
  it('DESIGN_MAP_PATH 是 docs/design/map.json', () => {
    expect(DESIGN_MAP_PATH).toBe('docs/design/map.json');
  });

  it('清单和包、文件都对得上，返回空数组', () => {
    const design = designOf('conventions');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: design }),
      [design]: '# conventions\n',
      [PKG]: 'export {}\n',
    });
    expect(readDesignMap(repo)).toEqual({ conventions: design });
    expect(checkDesignMap(repo)).toEqual([]);
  });

  it('多个包指向同一个设计文件，返回空数组', () => {
    const design = 'docs/design/flow.md';
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ engine: design, api: design }),
      [design]: '# flow\n',
      'packages/engine/src/index.ts': 'export {}\n',
      'packages/api/src/index.ts': 'export {}\n',
    });
    expect(checkDesignMap(repo)).toEqual([]);
  });

  it('设计文件可以在 docs/design/ 的子目录里', () => {
    const design = 'docs/design/engine/flow.md';
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ engine: design }),
      [design]: '# flow\n',
      'packages/engine/src/index.ts': 'export {}\n',
    });
    expect(checkDesignMap(repo)).toEqual([]);
  });

  it('packages/ 下的文件不算包', () => {
    const design = designOf('conventions');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: design }),
      [design]: '# conventions\n',
      [PKG]: 'export {}\n',
      'packages/README.md': '# readme\n',
    });
    expect(checkDesignMap(repo)).toEqual([]);
  });

  it('没有包、清单是空对象，返回空数组', () => {
    const repo = memRepo({ [DESIGN_MAP_PATH]: '{}\n', 'packages/': '' });
    expect(readDesignMap(repo)).toEqual({});
    expect(checkDesignMap(repo)).toEqual([]);
  });

  it('readDesignMap 读不成就抛错，不返回空对象', () => {
    expect(() => readDesignMap(memRepo({ [PKG]: 'export {}\n' }))).toThrow(/读不到/);
    expect(() => readDesignMap(memRepo({ [DESIGN_MAP_PATH]: '{', [PKG]: 'export {}\n' }))).toThrow(/JSON/);
    expect(() => readDesignMap(memRepo({ [DESIGN_MAP_PATH]: '[]', [PKG]: 'export {}\n' }))).toThrow(/对象/);
    expect(() =>
      readDesignMap(memRepo({ [DESIGN_MAP_PATH]: '{"conventions":1}', [PKG]: 'export {}\n' })),
    ).toThrow(/字符串/);
  });

  it('包没有对应设计文件，文字点出包名', () => {
    const design = designOf('conventions');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: design }),
      [design]: '# conventions\n',
      [PKG]: 'export {}\n',
      'packages/hygiene/src/index.ts': 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('hygiene');
    expect(problems[0]?.text).toContain('没有对应设计文件');
  });

  it('清单里的键在 packages/ 下不是目录，文字点出这个键', () => {
    const design = designOf('conventions');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: design, ghost: design }),
      [design]: '# conventions\n',
      [PKG]: 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('ghost');
    expect(problems[0]?.text).toContain('不是目录');
  });

  it('键对应的是 packages/ 下的文件而不是目录，文字点出这个键', () => {
    const design = 'docs/design/notes.md';
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ 'README.md': design }),
      [design]: '# notes\n',
      'packages/README.md': '# readme\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('README.md');
    expect(problems[0]?.text).toContain('不是目录');
  });

  it('设计文件不存在，文字点出文件路径', () => {
    const design = designOf('conventions');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: design }),
      [PKG]: 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain(design);
    expect(problems[0]?.text).toContain('不存在');
  });

  it('清单指向的路径是目录，算设计文件不存在', () => {
    const design = designOf('conventions');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: design }),
      [`${design}/`]: '',
      [PKG]: 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain(design);
    expect(problems[0]?.text).toContain('不存在');
  });

  it('值不在 docs/design/ 下，文字点出包名和路径', () => {
    const pointed = 'docs/ops.md';
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: pointed }),
      [pointed]: '# ops\n',
      [PKG]: 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('conventions');
    expect(problems[0]?.text).toContain(pointed);
    expect(problems[0]?.text).toContain('不在 docs/design/');
  });

  it('值不是 .md，文字点出包名和路径', () => {
    const pointed = 'docs/design/conventions.txt';
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: pointed }),
      [pointed]: '不是 markdown\n',
      [PKG]: 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('conventions');
    expect(problems[0]?.text).toContain(pointed);
    expect(problems[0]?.text).toContain('不是 .md');
  });

  it('值用 .. 逃出 docs/design/，算路径不对并点出这条路径', () => {
    const pointed = 'docs/design/../secrets.md';
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: pointed }),
      'docs/secrets.md': '# secret\n',
      [PKG]: 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('conventions');
    expect(problems[0]?.text).toContain(pointed);
    expect(problems[0]?.text).toContain('不在 docs/design/');
  });

  it('写成 ./ 开头的路径不算 docs/design/ 下的相对路径', () => {
    const pointed = './docs/design/conventions.md';
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: pointed }),
      'docs/design/conventions.md': '# conventions\n',
      [PKG]: 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain(pointed);
    expect(problems[0]?.text).toContain('不在 docs/design/');
  });

  it('缺包和设计文件不存在同时出现，两条都报', () => {
    const design = designOf('conventions');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: design }),
      [PKG]: 'export {}\n',
      'packages/hygiene/src/index.ts': 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.notQueried === false)).toBe(true);
    expect(problems.some((p) => p.text.includes('hygiene') && p.text.includes('没有对应设计文件'))).toBe(
      true,
    );
    expect(problems.some((p) => p.text.includes(design) && p.text.includes('不存在'))).toBe(true);
  });

  it('读不到 docs/design/map.json，返回没查成', () => {
    const repo = memRepo({
      [PKG]: 'export {}\n',
      'docs/design/conventions.md': '# conventions\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('读不到');
    expect(problems[0]?.text).toContain(DESIGN_MAP_PATH);
  });

  it('内容不是合法 JSON，返回没查成', () => {
    const repo = memRepo({
      [DESIGN_MAP_PATH]: '{',
      [PKG]: 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('JSON');
  });

  it('顶层不是对象，返回没查成', () => {
    for (const body of ['[]', 'null', '"docs/design/conventions.md"', '1', 'true']) {
      const repo = memRepo({
        [DESIGN_MAP_PATH]: body,
        [PKG]: 'export {}\n',
      });
      const problems = checkDesignMap(repo);
      expect(problems, body).toHaveLength(1);
      expect(problems[0]?.notQueried, body).toBe(true);
      expect(problems[0]?.text, body).toContain('对象');
    }
  });

  it('某个值不是字符串，返回没查成', () => {
    const design = designOf('conventions');
    const values: unknown[] = [[design], 1, null, true, { path: design }];
    for (const value of values) {
      const repo = memRepo({
        [DESIGN_MAP_PATH]: JSON.stringify({ conventions: value }),
        [design]: '# conventions\n',
        [PKG]: 'export {}\n',
      });
      const label = JSON.stringify(value);
      const problems = checkDesignMap(repo);
      expect(problems, label).toHaveLength(1);
      expect(problems[0]?.notQueried, label).toBe(true);
      expect(problems[0]?.text, label).toContain('conventions');
      expect(problems[0]?.text, label).toContain('字符串');
    }
  });

  it('列不出 packages/ 下的目录，返回没查成', () => {
    const design = designOf('conventions');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: design }),
      [design]: '# conventions\n',
    });
    expect(readDesignMap(repo)).toEqual({ conventions: design });
    const problems = checkDesignMap(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('packages/');
  });
});

// 闸门和检查配的故意造出失败：缺包、设计文件缺，都要报成问题，不能当成通过，也不能当成没查成。
describe('故意造出失败', () => {
  it('包缺清单', () => {
    const design = designOf('conventions');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ conventions: design }),
      [design]: '# conventions\n',
      [PKG]: 'export {}\n',
      'packages/web/src/index.ts': 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.notQueried === false)).toBe(true);
    expect(problems.some((p) => p.text.includes('web'))).toBe(true);
  });

  it('设计文件不存在', () => {
    const design = designOf('web');
    const repo = memRepo({
      [DESIGN_MAP_PATH]: JSON.stringify({ web: design }),
      'packages/web/src/index.ts': 'export {}\n',
    });
    const problems = checkDesignMap(repo);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.notQueried === false)).toBe(true);
    expect(problems.some((p) => p.text.includes(design))).toBe(true);
  });
});
