// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Stack } from './stack';

afterEach(cleanup);

describe('Stack', () => {
  test('默认竖排、gap lg（16）', () => {
    const { container } = render(<Stack>a</Stack>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.direction).toBe('vertical');
    expect(el.className).toContain('flex-col');
    expect(el.className).toContain('gap-4');
  });

  test.each([
    ['sm', 'gap-2'],
    ['md', 'gap-3'],
    ['lg', 'gap-4'],
    ['xl', 'gap-6'],
  ] as const)('gap=%s 对 %s', (gap, cls) => {
    const { container } = render(<Stack gap={gap}>a</Stack>);
    expect((container.firstElementChild as HTMLElement).className).toContain(cls);
    cleanup();
  });

  test('横排、对齐、两端、换行', () => {
    const { container } = render(
      <Stack direction="horizontal" align="center" justify="between" wrap>
        a
      </Stack>,
    );
    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).toContain('flex-row');
    expect(cls).toContain('items-center');
    expect(cls).toContain('justify-between');
    expect(cls).toContain('flex-wrap');
  });
});
