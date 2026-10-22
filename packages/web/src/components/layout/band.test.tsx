// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Band } from './band';
import { Nest } from './nest';

afterEach(cleanup);

describe('Band、Nest', () => {
  test('Band 默认浅灰，danger 是淡红；data-* 落在最外层', () => {
    const { container } = render(
      <>
        <Band data-engine-chain>引擎</Band>
        <Band tone="danger" data-rework-why>
          为什么返工
        </Band>
      </>,
    );
    const [muted, danger] = [...container.children] as HTMLElement[];
    expect(muted?.getAttribute('data-tone')).toBe('muted');
    expect(muted?.hasAttribute('data-engine-chain')).toBe(true);
    expect(danger?.getAttribute('data-tone')).toBe('danger');
    expect(danger?.textContent).toBe('为什么返工');
  });

  test('Nest 包住子内容并透传 data-*', () => {
    const { container } = render(<Nest data-sub>子代理说的话</Nest>);
    expect(container.querySelector('[data-sub]')?.textContent).toBe('子代理说的话');
  });
});
