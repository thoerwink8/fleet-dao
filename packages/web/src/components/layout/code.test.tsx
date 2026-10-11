// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Code } from './code';

afterEach(cleanup);

describe('Code', () => {
  test('渲染 <code>，用等宽字体和等宽数字', () => {
    render(<Code>claude-sonnet-5-5</Code>);
    const el = screen.getByText('claude-sonnet-5-5');
    expect(el.tagName).toBe('CODE');
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('tabular-nums');
  });
});
