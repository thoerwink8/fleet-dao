// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Message } from './chat';
import { Markdown } from './markdown';

afterEach(cleanup);

describe('Markdown', () => {
  test('段落、加粗、行内代码、列表、代码块；data-* 落在最外层', () => {
    const { container } = render(
      <Markdown
        text={'先说**结论**。\n\n- 改了 `a.ts`\n- 补了测试\n\n```ts\nconst x = 1;\n```'}
        data-kind="assistant"
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.kind).toBe('assistant');
    expect(root.querySelector('strong')?.textContent).toBe('结论');
    expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['改了 a.ts', '补了测试']);
    expect(root.querySelector('li code')?.textContent).toBe('a.ts');
    expect(root.querySelector('[data-md-code]')?.textContent).toBe('const x = 1;');
  });

  test('tone=secondary 灰一档，strong 加粗；默认正文黑', () => {
    const { container } = render(
      <>
        <Markdown text="默认" />
        <Markdown text="灰" tone="secondary" />
        <Markdown text="粗" strong />
      </>,
    );
    const [a, b, c] = Array.from(container.children) as HTMLElement[];
    expect(a?.className).toContain('text-ink');
    expect(a?.className).not.toContain('text-ink-2');
    expect(b?.className).toContain('text-ink-2');
    expect(c?.className).toContain('font-medium');
  });

  test('链接新窗口打开且不带 opener', () => {
    const { container } = render(<Markdown text="见 [这里](https://example.com/a) 看" />);
    const a = container.querySelector('a') as HTMLAnchorElement;
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
  });
});

describe('Message 的 kind', () => {
  test('kind 只写在 data-kind 上，不给就没有这个属性', () => {
    const { container } = render(
      <>
        {/* biome-ignore lint/a11y/useValidAriaRole: Message 的 role 是自己的角色名，不是 ARIA role。 */}
        <Message role="me" kind="prompt">
          提示词
        </Message>
        {/* biome-ignore lint/a11y/useValidAriaRole: Message 的 role 是自己的角色名（me/other/tool），不是 ARIA role。 */}
        <Message role="other">别的</Message>
      </>,
    );
    const [a, b] = Array.from(container.children) as HTMLElement[];
    expect(a?.dataset.kind).toBe('prompt');
    expect(b?.dataset.kind).toBeUndefined();
  });
});
