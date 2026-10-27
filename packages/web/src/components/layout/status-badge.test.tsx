// @vitest-environment happy-dom
// StatusBadge / StatusDot：主用法按字典键取中文和等级；旧的 tone/label 写法还在，外观也照「颜色只给异常」。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { STATUS_KEYS, statusEntry } from '../../theme/status-dict';
import { LevelDot, StatusBadge, StatusDot } from './status-badge';
import { LAYOUT_TONES } from './tone';

afterEach(cleanup);

describe('StatusBadge（字典键）', () => {
  test('中文和等级都从字典取', () => {
    render(<StatusBadge status="task:running" />);
    const el = screen.getByText('在干活').closest('[data-status]') as HTMLElement;
    expect(el.dataset.status).toBe('task:running');
    expect(el.dataset.level).toBe('processing');
  });

  test('success、processing、default 画圆点加字，没有底色标签', () => {
    for (const s of ['task:done', 'task:running', 'task:queued'] as const) {
      const { container } = render(<StatusBadge status={s} />);
      const chip = container.firstElementChild as HTMLElement;
      expect(chip.querySelector('[aria-hidden][data-level]')).not.toBeNull();
      expect(chip.className).not.toMatch(/bg-warn-1|bg-fail-1/);
      cleanup();
    }
  });

  test('warning 画橙底标签、error 画红底标签，标签里没有圆点', () => {
    const { container, rerender } = render(<StatusBadge status="task:stalled" />);
    let chip = container.firstElementChild as HTMLElement;
    expect(chip.className).toContain('bg-warn-1');
    expect(chip.querySelector('[data-level]')).toBeNull();
    rerender(<StatusBadge status="task:failed" />);
    chip = container.firstElementChild as HTMLElement;
    expect(chip.className).toContain('bg-fail-1');
    expect(chip.textContent).toBe('失败');
  });

  test('variant=dot：warning、error 也只画点加字', () => {
    const { container } = render(<StatusBadge status="task:failed" variant="dot" />);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.className).not.toContain('bg-fail-1');
    expect(chip.querySelector('[data-level="error"]')).not.toBeNull();
  });

  test('正常态画灰点，绿点只给强调的那几条（决定 0121 第 2 条）', () => {
    const dotOf = (status: string) => {
      const { container } = render(<StatusBadge status={status as never} />);
      const dot = container.querySelector('[aria-hidden][data-level]') as HTMLElement;
      cleanup();
      return dot;
    };
    // 「已完成」「开着」「在线」这类正常态：灰点
    for (const s of ['task:done', 'pr:open', 'machine:node:fresh']) {
      expect(dotOf(s).className, s).toContain('bg-ink-3');
      expect(dotOf(s).className, s).not.toContain('bg-success');
      expect(dotOf(s).hasAttribute('data-emphasis'), s).toBe(false);
    }
    // 强调态：绿点
    for (const s of ['task:round:merged', 'notification:repair:verified']) {
      expect(dotOf(s).className, s).toContain('bg-success');
      expect(dotOf(s).hasAttribute('data-emphasis'), s).toBe(true);
    }
  });

  test('unknown 画灰色「未知」，title 写在标签自己身上', () => {
    const { container } = render(<StatusBadge status="unknown" title="原值 brand_new" />);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.textContent).toBe('未知');
    expect(chip.dataset.level).toBe('default');
    expect(chip.getAttribute('title')).toBe('原值 brand_new');
  });

  test('字典里每个键都能画出自己的中文', () => {
    for (const k of STATUS_KEYS) {
      const { container } = render(<StatusBadge status={k} />);
      expect(container.textContent).toBe(statusEntry(k).label);
      cleanup();
    }
  });
});

describe('StatusBadge（旧的 tone/label）', () => {
  test.each(LAYOUT_TONES)('tone=%s 渲染 data-tone 和文字', (tone) => {
    render(<StatusBadge tone={tone} label={`状态-${tone}`} />);
    const el = screen.getByText(`状态-${tone}`);
    expect(el.dataset.tone).toBe(tone);
    expect(el.dataset.variant).toBe('soft');
  });

  test('title 写在带 data-tone 的标签上，不另包一层', () => {
    const { container } = render(<StatusBadge tone="stop" label="已下架" title="模型已下架" />);
    const chip = container.querySelector('span');
    expect(chip?.textContent).toContain('已下架');
    expect(chip?.getAttribute('data-tone')).toBe('stop');
    expect(chip?.getAttribute('title')).toBe('模型已下架');
  });

  test('旧 tone 的外观也照「颜色只给异常」：只有 stall、doubt（橙）和 fail（红）有底色', () => {
    const bg = (tone: (typeof LAYOUT_TONES)[number]) => {
      const { container } = render(<StatusBadge tone={tone} label="x" />);
      const cls = (container.firstElementChild as HTMLElement).className;
      cleanup();
      return /bg-warn-1/.test(cls) ? 'orange' : /bg-fail-1/.test(cls) ? 'red' : 'none';
    };
    expect(LAYOUT_TONES.map(bg)).toEqual(['none', 'none', 'none', 'orange', 'red', 'none', 'none', 'orange']);
  });

  test('variant=dot 只有点和字', () => {
    const { container } = render(<StatusBadge tone="done" label="完成" variant="dot" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[data-level="success"][aria-hidden]')).not.toBeNull();
  });
});

describe('LevelDot / StatusDot', () => {
  test('LevelDot 按等级标 data-level', () => {
    const { container } = render(<LevelDot level="warning" />);
    expect((container.firstElementChild as HTMLElement).dataset.level).toBe('warning');
  });

  test.each(LAYOUT_TONES)('旧 StatusDot tone=%s 渲染 data-tone，只有 run 会扩散', (tone) => {
    const { container } = render(<StatusDot tone={tone} />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.dataset.tone).toBe(tone);
    expect(dot.className.includes('fd-dot-live')).toBe(tone === 'run');
  });
});
