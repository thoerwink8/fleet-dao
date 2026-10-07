// @vitest-environment happy-dom
// 更新日志的最小 Markdown 渲染：小标题、列表、行内代码要渲染成元素，不再把「###」「- 」原样露在页面上；
// 认不出的写法原样当文字，不当 HTML 解释。
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { MarkdownLite, parseBlocks } from './markdown-lite';

afterEach(cleanup);

describe('MarkdownLite', () => {
  test('小标题、列表、段落分块；列表项的缩进续行接到上一项', () => {
    expect(parseBlocks('### 新的能做的事\n\n- 一\n- 二\n  接着二\n\n一段话')).toEqual([
      { kind: 'heading', level: 3, text: '新的能做的事' },
      { kind: 'list', items: ['一', '二 接着二'] },
      { kind: 'para', text: '一段话' },
    ]);
  });

  test('渲染出来没有「###」「- 」记号；行内代码、粗体、链接变成元素', () => {
    const { container } = render(
      <MarkdownLite
        source={'### 改了行为\n\n- 用 `pnpm plan` 看 **计划**，见 [说明](https://example.com/a)'}
      />,
    );
    expect(container.querySelector('h3')?.textContent).toBe('改了行为');
    expect(container.textContent).not.toMatch(/###|^- /);
    expect(container.querySelector('code')?.textContent).toBe('pnpm plan');
    expect(container.querySelector('strong')?.textContent).toBe('计划');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a');
  });

  test('【故意造出的失败】写进去的 HTML 原样当文字，不变成元素；非 http 的链接不变成链接', () => {
    const { container } = render(
      <MarkdownLite source={'- <img src=x onerror=alert(1)> 和 [点我](javascript:alert(1))'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
