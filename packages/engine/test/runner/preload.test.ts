// 首轮预载（runner/preload.ts，决定 0093）：单子列的文件原文放进提示词，总量有上限，截了哪些、没放哪些逐个写明。
import { describe, expect, it } from 'vitest';
import {
  PRELOAD_MAX_FILES,
  type PreloadRead,
  preloadFromBytes,
  preloadPaths,
  renderPreload,
} from '../../src/runner/preload.ts';

const text = (path: string, content: string): PreloadRead => ({ path, kind: 'text', content });

describe('preloadPaths', () => {
  it('只取写成具体文件的路径，去重、按写的先后；目录、通配、认不出的不展开', () => {
    expect(
      preloadPaths([
        '`packages/engine/src/runner/segment-prompt.ts`：拼提示词',
        '`packages/engine/src/real/`',
        '`packages/web/src/*.tsx`',
        '卡片渲染那一块',
        '`packages/engine/src/runner/segment-prompt.ts`',
        '`README.md`',
      ]),
    ).toEqual(['packages/engine/src/runner/segment-prompt.ts', 'README.md']);
  });

  it(`最多 ${PRELOAD_MAX_FILES} 个`, () => {
    const many = Array.from({ length: PRELOAD_MAX_FILES + 5 }, (_, i) => `\`f${i}.ts\``);
    expect(preloadPaths(many)).toHaveLength(PRELOAD_MAX_FILES);
  });
});

describe('preloadFromBytes', () => {
  it('null 是不在；带 NUL 是二进制；其余按 utf8', () => {
    expect(preloadFromBytes('a', null)).toEqual({ path: 'a', kind: 'absent' });
    expect(preloadFromBytes('a', Buffer.from([0x50, 0, 0x4e]))).toEqual({ path: 'a', kind: 'binary' });
    expect(preloadFromBytes('a', Buffer.from('中文\n'))).toEqual({
      path: 'a',
      kind: 'text',
      content: '中文\n',
    });
  });
});

describe('renderPreload', () => {
  it('一个都没有：不出这一节', () => {
    expect(renderPreload([])).toEqual([]);
  });

  it('放得下：整份放进来，说明别再读', () => {
    const out = renderPreload([text('a.ts', 'export const a = 1;\n')]).join('\n');
    expect(out).toContain('## 已给你的文件（别再读）');
    expect(out).toContain('不要再读一遍');
    expect(out).toContain('### `a.ts`\n```\nexport const a = 1;\n```');
    expect(out).not.toContain('截了的');
  });

  it('超了总量：前面的优先放全，跨线的那个截断并写明放了多少，剩下额度太少的整份记成没放', () => {
    const out = renderPreload(
      [
        text('first.ts', 'a'.repeat(3000)),
        text('second.ts', 'b'.repeat(5000)),
        text('third.ts', 'c'.repeat(100)),
      ],
      6000,
    ).join('\n');
    expect(out).toContain('a'.repeat(3000));
    expect(out).toContain(`${'b'.repeat(3000)}\n\`\`\``);
    expect(out).not.toContain('b'.repeat(3001));
    expect(out).toContain('截了的（后半段没放，用到再读那一段）：`second.ts`（共 5000 字，放了前 3000 字）');
    expect(out).toContain('超了总量没放的（要看自己读）：`third.ts`');
    expect(out).not.toContain('### `third.ts`');
  });

  it('不在、二进制、没读到：各写一句，不拿空内容冒充', () => {
    const out = renderPreload([
      { path: 'new.ts', kind: 'absent' },
      { path: 'logo.png', kind: 'binary' },
      { path: 'x.ts', kind: 'error', why: '权限不够' },
    ]).join('\n');
    expect(out).toContain('`new.ts`：工作树里没有这个文件');
    expect(out).toContain('`logo.png`：是二进制文件');
    expect(out).toContain('`x.ts`：引擎没读到（权限不够），要看自己读');
    expect(out).not.toContain('### ');
  });

  it('文件里本身有 ``` ：外层围栏加长，不被提前截断', () => {
    const out = renderPreload([text('doc.md', '```ts\nx\n```\n')]).join('\n');
    expect(out).toContain('### `doc.md`\n````\n```ts\nx\n```\n````');
  });
});
