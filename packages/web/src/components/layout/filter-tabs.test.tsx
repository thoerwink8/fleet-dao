// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FilterTabs } from './filter-tabs';

afterEach(cleanup);

const items = [
  { id: 'all', label: '全部', count: 24 },
  { id: 'run', label: '在跑', count: null, tone: 'run' as const },
  { id: 'done', label: '完成' },
];

describe('FilterTabs', () => {
  test('页签：role=tablist/tab，选中的 aria-selected，点哪个就把 id 交给 onChange', () => {
    const onChange = vi.fn();
    render(<FilterTabs aria-label="按状态" items={items} value="all" onChange={onChange} />);
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('按状态');
    expect(screen.getByRole('tab', { name: /全部/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /完成/ }).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(screen.getByRole('tab', { name: /完成/ }));
    expect(onChange).toHaveBeenCalledWith('done');
  });

  test('每个标签手机上不小于 40，条上带渐隐提示用的类', () => {
    render(<FilterTabs aria-label="按状态" items={items} value="all" onChange={() => {}} />);
    for (const tab of screen.getAllByRole('tab')) expect(tab.className).toContain('max-md:min-h-10');
    expect(screen.getByRole('tablist').className).toContain('fade-edges-x');
  });

  test('计数：有数写数，null 写「—」不冒充 0，不传就不画', () => {
    render(<FilterTabs aria-label="按状态" items={items} value="all" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: /全部/ }).textContent).toContain('24');
    expect(screen.getByRole('tab', { name: /在跑/ }).textContent).toContain('—');
    expect(screen.getByRole('tab', { name: '完成' }).textContent).toBe('完成');
  });

  test('主筛选是 Arco 下划线页签：选中品牌色字加品牌色底线，没有灰底轨道；次级的选中用 fill-2 底（#3509）', () => {
    const { rerender } = render(
      <FilterTabs aria-label="按状态" items={items} value="all" onChange={() => {}} />,
    );
    const list = screen.getByRole('tablist');
    expect(list.getAttribute('data-variant')).toBe('primary');
    expect(list.className).not.toContain('bg-fill-2');
    const on = screen.getByRole('tab', { name: /全部/ });
    expect(on.className).toContain('border-brand');
    expect(on.className).toContain('text-brand-ink');
    expect(on.className).not.toContain('bg-card');
    const off = screen.getByRole('tab', { name: '完成' });
    expect(off.className).toContain('border-transparent');
    expect(off.className).toContain('text-ink-2');
    // 计数：选中的 brand-1 底，没选的灰底
    expect(on.querySelector('[data-tab-count]')?.className).toContain('bg-brand-1');
    expect(screen.getByRole('tab', { name: /在跑/ }).querySelector('[data-tab-count]')?.className).toContain(
      'bg-fill-2',
    );
    rerender(
      <FilterTabs aria-label="按状态" variant="secondary" items={items} value="all" onChange={() => {}} />,
    );
    expect(screen.getByRole('tablist').getAttribute('data-variant')).toBe('secondary');
    expect(screen.getByRole('tab', { name: /全部/ }).className).toContain('bg-fill-2');
    expect(screen.getByRole('tab', { name: /全部/ }).className).not.toContain('border-b-2');
  });

  test('页签：方向键、Home、End 换页签（循环），只有选中的在 Tab 序里；idPrefix 给页签 id', () => {
    const onChange = vi.fn();
    render(<FilterTabs aria-label="按状态" idPrefix="x" items={items} value="all" onChange={onChange} />);
    const all = screen.getByRole('tab', { name: /全部/ });
    expect(all.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: /完成/ }).getAttribute('tabindex')).toBe('-1');
    expect(all.id).toBe('x-all');
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('run');
    fireEvent.keyDown(all, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('done');
    fireEvent.keyDown(all, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('done');
    fireEvent.keyDown(all, { key: 'a' });
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  test('标签放不下时哪一端还有内容，哪一端就渐隐（滑到头那端没有）', () => {
    render(<FilterTabs aria-label="按状态" items={items} value="all" onChange={() => {}} />);
    const bar = screen.getByRole('tablist');
    expect(bar.getAttribute('data-fade-end')).toBeNull();
    Object.defineProperty(bar, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(bar, 'scrollWidth', { configurable: true, value: 300 });
    fireEvent.scroll(bar);
    expect(bar.getAttribute('data-fade-end')).toBe('true');
    expect(bar.getAttribute('data-fade-start')).toBeNull();
    bar.scrollLeft = 200;
    fireEvent.scroll(bar);
    expect(bar.getAttribute('data-fade-end')).toBeNull();
    expect(bar.getAttribute('data-fade-start')).toBe('true');
  });

  test('toggle 模式：一组按钮，选中的 aria-pressed', () => {
    render(<FilterTabs mode="toggle" aria-label="按级别" items={items} value="run" onChange={() => {}} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('按级别');
    expect(screen.getByRole('button', { name: /在跑/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /全部/ }).getAttribute('aria-pressed')).toBe('false');
  });
});
