// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { Scale } from 'lucide-react';
import { afterEach, describe, expect, test } from 'vitest';
import { Glyph } from './glyph';

afterEach(cleanup);

describe('Glyph', () => {
  test('默认 body：16 图标、读屏跳过、灰一档', () => {
    const { container } = render(<Glyph icon={Scale} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.className).toContain('text-ink-2');
    expect(el.querySelector('svg')?.getAttribute('class')).toContain('size-4');
  });

  test('meta：12 图标；warning 画橙字；data-* 落在外层', () => {
    const { container } = render(<Glyph icon={Scale} size="meta" tone="warning" data-x="1" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('text-warn-ink');
    expect(el.getAttribute('data-x')).toBe('1');
    expect(el.querySelector('svg')?.getAttribute('class')).toContain('size-3');
  });
});
