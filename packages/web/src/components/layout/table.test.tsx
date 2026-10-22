// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Table, type TableColumn } from './table';

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  cost: number | null;
}
const rows: Row[] = [
  { id: 'a', name: '扫描', cost: 12 },
  { id: 'b', name: '对账', cost: null },
];
const columns: TableColumn<Row>[] = [
  { key: 'name', title: '名字' },
  {
    key: 'cost',
    title: '耗时',
    align: 'right',
    render: (v) => (typeof v === 'number' ? `${v} 秒` : '没读到'),
  },
];

describe('Table', () => {
  test('表头、行、render、没写 render 的格子取 row[key]；null 画「—」不画 null', () => {
    const { container } = render(<Table columns={columns} rows={rows} rowKey="id" />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['名字', '耗时']);
    expect(screen.getByText('12 秒')).toBeTruthy();
    expect(screen.getByText('没读到')).toBeTruthy();
    const noRender = render(<Table columns={[{ key: 'cost', title: 'c' }]} rows={rows} rowKey="id" />);
    expect(noRender.container.textContent).toContain('—');
    expect(container.textContent).not.toMatch(/null|undefined/);
  });

  test('右对齐；rowKey 可以是函数', () => {
    render(<Table columns={columns} rows={rows} rowKey={(r) => `k-${r.id}`} />);
    expect(screen.getByText('耗时').className).toContain('text-right');
    expect(document.querySelector('[data-row-key="k-a"]')).not.toBeNull();
  });

  test('selectedKey 标出选中行；onRowClick 点行、Enter 也行', () => {
    const onRowClick = vi.fn();
    render(<Table columns={columns} rows={rows} rowKey="id" selectedKey="b" onRowClick={onRowClick} />);
    const b = document.querySelector('[data-row-key="b"]') as HTMLElement;
    expect(b.dataset.selected).toBe('true');
    expect(b.getAttribute('aria-current')).toBe('true');
    expect((document.querySelector('[data-row-key="a"]') as HTMLElement).dataset.selected).toBeUndefined();
    fireEvent.click(screen.getByText('扫描'));
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    fireEvent.keyDown(b, { key: 'Enter' });
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
  });

  test('expandable：点箭头展开明细行，再点收起；rowExpandable 为假的行没有箭头', () => {
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey="id"
        expandable={{ render: (r) => <span>明细-{r.id}</span>, rowExpandable: (r) => r.id === 'a' }}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    const btn = screen.getByRole('button', { name: '展开' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(screen.getByText('明细-a')).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText('明细-a')).toBeNull();
  });

  test('展开箭头不触发整行点击；defaultExpandedKeys 一开始就展开', () => {
    const onRowClick = vi.fn();
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey="id"
        onRowClick={onRowClick}
        expandable={{ render: () => <span>开着的明细</span>, defaultExpandedKeys: ['b'] }}
      />,
    );
    expect(screen.getByText('开着的明细')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /展开|收起/ })[0] as HTMLElement);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  test('空：画 empty，不写＝「没有数据」', () => {
    const { rerender } = render(<Table columns={columns} rows={[]} rowKey="id" />);
    expect(screen.getByText('没有数据')).toBeTruthy();
    rerender(<Table columns={columns} rows={[]} rowKey="id" empty={<b>还没有任务</b>} />);
    expect(screen.getByText('还没有任务')).toBeTruthy();
  });

  test('load=loading：骨架行，aria-busy，不画真数据', () => {
    const { container } = render(
      <Table columns={columns} rows={rows} rowKey="id" load={{ state: 'loading' }} />,
    );
    expect(container.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('扫描')).toBeNull();
  });

  test('load=error：红提示条写「没读到 X：原因」加重试，整张表不画（不画成空表或 0）', () => {
    const onRetry = vi.fn();
    const { container } = render(
      <Table
        columns={columns}
        rows={[]}
        rowKey="id"
        load={{ state: 'error', what: '任务', reason: '连不上后端', onRetry }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('没读到任务：连不上后端');
    expect(container.querySelector('table')).toBeNull();
    expect(screen.queryByText('没有数据')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('表格自己带横向滚动盒', () => {
    const { container } = render(<Table columns={columns} rows={rows} rowKey="id" />);
    expect((container.firstElementChild as HTMLElement).className).toContain('overflow-x-auto');
  });
});

describe('Table 分组行和附加行', () => {
  test('groupRow 在该行上面通栏画一行、subRow 在下面；返回 null 不画', () => {
    const { container } = render(
      <Table
        columns={columns}
        rows={rows}
        rowKey="id"
        groupRow={(r) => (r.id === 'a' ? '渠道一' : null)}
        subRow={(r) => (r.id === 'b' ? <span>就地表单</span> : null)}
      />,
    );
    const trs = [...container.querySelectorAll('tbody tr')];
    expect(
      trs.map(
        (t) =>
          t.getAttribute('data-group-for') ??
          t.getAttribute('data-sub-for') ??
          t.getAttribute('data-row-key'),
      ),
    ).toEqual(['a', 'a', 'b', 'b']);
    expect(trs[0]?.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(screen.getByText('渠道一')).toBeTruthy();
    expect(screen.getByText('就地表单')).toBeTruthy();
    expect(container.querySelectorAll('[data-group-for]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-sub-for]')).toHaveLength(1);
  });

  test('fill 列吃剩下的宽、字可以折行，其余列默认不折', () => {
    const cols: TableColumn<Row>[] = [
      { key: 'name', title: '名字', fill: true },
      { key: 'cost', title: '耗时' },
    ];
    const { container } = render(<Table columns={cols} rows={rows} rowKey="id" />);
    const tds = container.querySelectorAll('tbody tr:first-child td');
    expect(tds[0]?.className).toContain('whitespace-normal');
    expect(tds[0]?.className).toContain('max-w-0');
    expect(tds[0]?.className).not.toContain('whitespace-nowrap');
    expect(tds[1]?.className).toContain('whitespace-nowrap');
  });
});
