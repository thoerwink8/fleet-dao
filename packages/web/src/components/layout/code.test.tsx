// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Code } from './code';

afterEach(cleanup);

describe('Code block', () => {
  test('block：多行原文画成 <pre>，保留换行，太长在块里滚', () => {
    render(<Code block>{'请求 A\n请求 B'}</Code>);
    const el = screen.getByText(/请求 A/);
    expect(el.tagName).toBe('PRE');
    expect(el.textContent).toBe('请求 A\n请求 B');
    expect(el.className).toContain('whitespace-pre-wrap');
    expect(el.className).toContain('overflow-auto');
  });
});

describe('Code', () => {
  test('渲染 <code>，用等宽字体和等宽数字', () => {
    render(<Code>claude-sonnet-5-5</Code>);
    const el = screen.getByText('claude-sonnet-5-5');
    expect(el.tagName).toBe('CODE');
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('tabular-nums');
  });
});
