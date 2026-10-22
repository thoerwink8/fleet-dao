// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Text } from './text';

afterEach(cleanup);

describe('Text', () => {
  test('默认 body、正文黑、span', () => {
    render(<Text>你好</Text>);
    const el = screen.getByText('你好');
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toContain('text-body');
    expect(el.className).toContain('text-ink');
  });

  test.each([
    ['meta', 'text-meta'],
    ['body', 'text-body'],
    ['heading', 'text-heading'],
  ] as const)('size=%s', (size, cls) => {
    render(<Text size={size}>x</Text>);
    expect(screen.getByText('x').className).toContain(cls);
    cleanup();
  });

  test.each([
    ['secondary', 'text-ink-2'],
    ['muted', 'text-ink-3'],
    ['warning', 'text-warn-ink'],
    ['danger', 'text-fail-ink'],
  ] as const)('tone=%s 用字色令牌（不是填充色）', (tone, cls) => {
    render(<Text tone={tone}>x</Text>);
    const c = screen.getByText('x').className;
    expect(c).toContain(cls);
    expect(c).not.toMatch(/(^| )text-(warn|fail|brand)( |$)/);
    cleanup();
  });

  test('strong 加 500；mono 用等宽 13 且不再带 body 字号', () => {
    render(
      <>
        <Text strong>粗</Text>
        <Text mono>a1b2c3</Text>
      </>,
    );
    expect(screen.getByText('粗').className).toContain('font-medium');
    const m = screen.getByText('a1b2c3').className;
    expect(m).toContain('font-mono');
    expect(m).toContain('text-mono');
    expect(m).not.toContain('text-body');
  });

  test('truncate 按块排并省略；title 给全文；as 换标签', () => {
    render(
      <Text truncate as="p" title="全文全文">
        很长很长
      </Text>,
    );
    const el = screen.getByText('很长很长');
    expect(el.tagName).toBe('P');
    expect(el.className).toContain('truncate');
    expect(el.getAttribute('title')).toBe('全文全文');
  });

  test('as=strong 是行内的 strong；breakWords 长词折行', () => {
    render(
      <Text as="strong" strong breakWords>
        粗
      </Text>,
    );
    const el = screen.getByText('粗');
    expect(el.tagName).toBe('STRONG');
    expect(el.className).not.toContain('block');
    expect(el.className).toContain('break-words');
  });
});
