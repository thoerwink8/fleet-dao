// @vitest-environment happy-dom
// 行的三件版式组件（#1915 路由页样板，规范第三节「行：一个主信息、一个状态，次要操作收进「⋯」」）：
// RowFrame 行框取令牌、带 group/row；RowMenu 平时藏着、悬停这一行才露出，菜单项手机上 40 高；FilterTabGroups 组头不悬在半空。
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FilterTabGroups } from './filter-tabs';
import { RowFrame } from './list';
import { RowMenu, RowMenuItem, RowMenuLabel, RowMenuRadioGroup, RowMenuRadioItem } from './row-menu';

afterEach(cleanup);

const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

const open = (trigger: HTMLElement) => {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
};

describe('RowFrame', () => {
  test('行高、内边距、间距取组件令牌，带 group/row 和 relative（拖动柄浮在左边留白里）', () => {
    render(<RowFrame data-testid="row">行</RowFrame>);
    expect(classes(screen.getByTestId('row'))).toEqual(
      expect.arrayContaining([
        'group/row',
        'relative',
        'min-h-row',
        'px-section',
        'gap-stack',
        'max-md:min-h-11',
      ]),
    );
  });
});

describe('RowMenu', () => {
  test('「⋯」平时藏着（只在精确指针设备上），悬停这一行、焦点进这一行、菜单开着时露出；手机可点区 40', () => {
    render(
      <RowFrame>
        <RowMenu label="更多操作：甲">
          <RowMenuItem>一项</RowMenuItem>
        </RowMenu>
      </RowFrame>,
    );
    const trigger = screen.getByRole('button', { name: '更多操作：甲' });
    expect(classes(trigger)).toEqual(
      expect.arrayContaining([
        'pointer-fine:opacity-0',
        'pointer-fine:group-hover/row:opacity-100',
        'pointer-fine:group-focus-within/row:opacity-100',
        'data-[state=open]:opacity-100',
        'max-md:min-h-10',
        'max-md:min-w-10',
      ]),
    );
  });

  test('reveal={false} 一直显示', () => {
    render(
      <RowMenu label="更多操作：乙" reveal={false}>
        <RowMenuItem>一项</RowMenuItem>
      </RowMenu>,
    );
    expect(classes(screen.getByRole('button', { name: '更多操作：乙' }))).not.toContain(
      'pointer-fine:opacity-0',
    );
  });

  test('菜单项、单选项手机上至少 40 高；组头带一行说明；点了走 onSelect', async () => {
    const pick = vi.fn();
    const choose = vi.fn();
    render(
      <RowMenu label="更多操作：丙">
        <RowMenuLabel hint="为什么配不了">档位</RowMenuLabel>
        <RowMenuRadioGroup aria-label="档位" value="" onValueChange={choose}>
          <RowMenuRadioItem value="">不另配</RowMenuRadioItem>
          <RowMenuRadioItem value="high">高</RowMenuRadioItem>
        </RowMenuRadioGroup>
        <RowMenuItem onSelect={pick}>置顶</RowMenuItem>
      </RowMenu>,
    );
    open(screen.getByRole('button', { name: '更多操作：丙' }));
    const menu = await screen.findByRole('menu');
    expect(menu.textContent).toContain('为什么配不了');
    const item = within(menu).getByRole('menuitem', { name: '置顶' });
    expect(classes(item)).toContain('max-md:min-h-10');
    for (const radio of within(menu).getAllByRole('menuitemradio'))
      expect(classes(radio)).toContain('max-md:min-h-10');
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: '高' }));
    expect(choose).toHaveBeenCalledWith('high');
    open(screen.getByRole('button', { name: '更多操作：丙' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: '置顶' }));
    expect(pick).toHaveBeenCalledTimes(1);
  });
});

describe('FilterTabGroups', () => {
  test('每组是一个次级 FilterTabs；后一组的组头在组里、不在筛选条里，组间有细竖线；组尾灰字', () => {
    const onChange = vi.fn();
    render(
      <FilterTabGroups
        value="a"
        onChange={onChange}
        groups={[
          { key: 'one', 'aria-label': '第一组', items: [{ id: 'a', label: '甲' }] },
          {
            key: 'two',
            heading: '另一组',
            note: '丁不在这里',
            'aria-label': '第二组',
            items: [{ id: 'b', label: '乙' }],
          },
        ]}
      />,
    );
    for (const name of ['第一组', '第二组']) {
      expect(screen.getByRole('group', { name }).getAttribute('data-variant')).toBe('secondary');
    }
    const heading = screen.getByText('另一组');
    expect(heading.closest('[role=group]')).toBeNull();
    expect(heading.closest('[data-tab-group]')?.getAttribute('data-tab-group')).toBe('two');
    expect(classes(heading.closest('[data-tab-group]'))).toEqual(expect.arrayContaining(['md:border-l']));
    expect(screen.getByText('丁不在这里')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '乙' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
