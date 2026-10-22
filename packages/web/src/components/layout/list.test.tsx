// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { List, ListRow } from './list';
import { LAYOUT_TONES } from './tone';

afterEach(cleanup);

describe('ListRow', () => {
  test('主行文字、小字、行首、行尾都渲染', () => {
    render(
      <List>
        <ListRow leading={<i>头</i>} title="标题" meta="小字" trailing={<b>尾</b>} />
      </List>,
    );
    for (const t of ['头', '标题', '小字', '尾']) expect(screen.getByText(t)).toBeTruthy();
  });

  test('expandable：默认收起，点一下展开（aria-expanded），再点收起', () => {
    render(
      <List>
        <ListRow title="可展开" expandable details={<p>明细</p>} />
      </List>,
    );
    const btn = screen.getByRole('button', { name: /可展开/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('明细')).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('明细')).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByText('明细')).toBeNull();
  });

  test('defaultOpen 一开始就展开；明细也可以写在标签里面', () => {
    render(
      <List>
        <ListRow title="展开的" expandable defaultOpen>
          <p>里面的明细</p>
        </ListRow>
      </List>,
    );
    expect(screen.getByText('里面的明细')).toBeTruthy();
  });

  test('summary 自己排整行，不再用 title', () => {
    render(
      <List>
        <ListRow summary={<span>自己排的</span>} title="不该出现" />
      </List>,
    );
    expect(screen.getByText('自己排的')).toBeTruthy();
    expect(screen.queryByText('不该出现')).toBeNull();
  });

  test('onClick：整行是按钮；href：整行是链接；selected 标 data-selected', () => {
    const onClick = vi.fn();
    render(
      <MemoryRouter>
        <List>
          <ListRow title="按钮行" onClick={onClick} selected />
          <ListRow title="链接行" href="/tasks" />
        </List>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '按钮行' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: '链接行' }).getAttribute('href')).toBe('/tasks');
    expect(document.querySelector('[data-selected]')).not.toBeNull();
  });

  test.each(LAYOUT_TONES)('rail=%s 画左边竖线', (tone) => {
    render(
      <List>
        <ListRow title="问题行" rail={tone} />
      </List>,
    );
    expect(document.querySelector('[data-row-rail]')).not.toBeNull();
    cleanup();
  });

  test('没有 rail 就没有竖线', () => {
    render(
      <List>
        <ListRow title="正常行" />
      </List>,
    );
    expect(document.querySelector('[data-row-rail]')).toBeNull();
  });

  test('受控展开（手风琴）：open 以外面为准，点一下只回调 onOpenChange', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <List>
        <ListRow title="行" expandable open={false} onOpenChange={onOpenChange} details={<p>明细</p>} />
      </List>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText('明细')).toBeNull();
    rerender(
      <List>
        <ListRow title="行" expandable open onOpenChange={onOpenChange} details={<p>明细</p>} />
      </List>,
    );
    expect(screen.getByText('明细')).toBeTruthy();
  });

  test('rowLabel 给整行按钮读屏名字，选中的按钮行带 aria-current', () => {
    render(
      <List>
        <ListRow title="甲" rowLabel="甲：在线" selected onClick={() => {}} />
        <ListRow title="乙" rowLabel="乙：故障" onClick={() => {}} />
      </List>,
    );
    expect(screen.getByRole('button', { name: '甲：在线' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: '乙：故障' }).hasAttribute('aria-current')).toBe(false);
  });

  test('wrapTrailing：行尾是按钮时，手机上落到文字下面，标题不截断', () => {
    render(
      <List>
        <ListRow wrapTrailing title="一个很长的标题" meta="说明" trailing={<span>按钮</span>} />
        <ListRow title="普通行" trailing={<span>时间</span>} />
      </List>,
    );
    const wrapped = screen.getByText('一个很长的标题');
    expect(wrapped.className).toContain('break-words');
    expect(wrapped.className).not.toContain('truncate');
    expect(wrapped.parentElement?.parentElement?.className).toContain('max-md:flex-wrap');
    expect(screen.getByText('普通行').className).toContain('truncate');
  });
});
