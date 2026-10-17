// @vitest-environment happy-dom
// StatusBadge / StatusDot：每个状态渲染 data-tone，三种样式；断言 data-tone，不断言颜色类名。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { StatusBadge, StatusDot } from './status-badge';
import { LAYOUT_TONES } from './tone';

afterEach(cleanup);

describe('StatusBadge', () => {
  test.each(LAYOUT_TONES)('tone=%s 渲染 data-tone 和文字', (tone) => {
    render(<StatusBadge tone={tone} label={`状态-${tone}`} />);
    const el = screen.getByText(`状态-${tone}`);
    expect(el.dataset.tone).toBe(tone);
    expect(el.dataset.variant).toBe('soft');
  });

  test('title 写在带 data-tone 的胶囊上，不另包一层', () => {
    const { container } = render(<StatusBadge tone="stop" label="已下架" title="模型已下架" />);
    const chip = container.querySelector('span');
    expect(chip?.textContent).toContain('已下架');
    expect(chip?.getAttribute('data-tone')).toBe('stop');
    expect(chip?.getAttribute('title')).toBe('模型已下架');
    expect(chip?.closest('[data-tone]')?.getAttribute('data-tone')).toBe('stop');
  });

  test('soft 和 outline 带图标，在跑的用呼吸点；dot 只有点；icon=false 没有图标', () => {
    const { container, rerender } = render(<StatusBadge tone="fail" label="失败" />);
    expect(container.querySelector('svg')).not.toBeNull();
    rerender(<StatusBadge tone="fail" label="失败" icon={false} />);
    expect(container.querySelector('svg')).toBeNull();
    rerender(<StatusBadge tone="run" label="在跑" variant="outline" />);
    expect(container.querySelector('.fd-dot-live')).not.toBeNull();
    rerender(<StatusBadge tone="done" label="完成" variant="dot" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[data-tone="done"][aria-hidden]')).not.toBeNull();
  });
});

describe('StatusDot', () => {
  test.each(LAYOUT_TONES)('tone=%s 渲染 data-tone，只有 run 会扩散', (tone) => {
    const { container } = render(<StatusDot tone={tone} />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.dataset.tone).toBe(tone);
    expect(dot.className.includes('fd-dot-live')).toBe(tone === 'run');
  });
});
