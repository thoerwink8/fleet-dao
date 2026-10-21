// 表格（参数名照 antd，样子照 canvas/fd3.css 的 .table tr.detail .expand tr.sel）。
// 表头灰底 500 字；行之间一道细线；悬停整行 fill-1；选中行 brand-1；展开行 fill-1，里面不再套带底色或描边的框。
// 表格自己带横向滚动盒：列多了只在盒子里滚，页面不横滚。不收 className 和 style。
// 读数据的几种样子（方案第四节）：load 传 loading 画骨架行，传 error 画红提示条加「重试」、整张表不画；
// rows 为空画 empty。读失败不会被画成空表。
import { ChevronRight } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { cn } from '../../lib/utils';
import { Skeleton } from '../ui/skeleton';

export interface TableColumn<T> {
  /** 列的身份，同时是取值的字段名：没写 render 时显示 row[key]。 */
  key: string;
  title: ReactNode;
  align?: 'left' | 'right' | 'center';
  /** 列宽（设计值，px）；不写按内容。 */
  width?: number;
  /** 自己画这一格。value 是 row[key]。 */
  render?: (value: unknown, row: T, index: number) => ReactNode;
}

export type TableLoad =
  | { state: 'loading' }
  | {
      state: 'error';
      /** 没读到什么：「任务」。 */
      what: string;
      reason: string;
      onRetry?: () => void;
    };

export interface TableExpandable<T> {
  /** 展开后画什么。 */
  render: (row: T) => ReactNode;
  /** 哪些行能展开；不写＝都能。 */
  rowExpandable?: (row: T) => boolean;
  defaultExpandedKeys?: readonly string[];
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

function cellText(v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? '是' : '否';
  return '—';
}

export function Table<T extends object>({
  columns,
  rows,
  rowKey,
  expandable,
  selectedKey,
  onRowClick,
  empty,
  load,
  caption,
}: {
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  /** 行的身份：字段名或函数。 */
  rowKey: (keyof T & string) | ((row: T, index: number) => string);
  expandable?: TableExpandable<T>;
  /** 选中行的 key（左列表右详情时标出现在看的那行）。 */
  selectedKey?: string | null | undefined;
  /** 点整行；传了就能用键盘 Enter 点。 */
  onRowClick?: (row: T) => void;
  /** 没有行时画什么；不写＝「没有数据」。 */
  empty?: ReactNode;
  load?: TableLoad;
  /** 给读屏的表名。 */
  caption?: string;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(expandable?.defaultExpandedKeys ?? []));
  const keyOf = (row: T, i: number) =>
    typeof rowKey === 'function' ? rowKey(row, i) : String((row as Record<string, unknown>)[rowKey]);
  const span = columns.length + (expandable ? 1 : 0);

  if (load?.state === 'error') {
    return (
      <div
        role="alert"
        data-table-state="error"
        className="flex items-start gap-2 rounded-sm bg-fail-1 px-4 py-2 text-body text-ink"
      >
        <span className="min-w-0 flex-1 break-words">
          没读到{load.what}：{load.reason}
        </span>
        {load.onRetry ? (
          <button
            type="button"
            onClick={load.onRetry}
            className="shrink-0 rounded-sm text-brand-ink transition-colors hover:text-link-hover"
          >
            重试
          </button>
        ) : null}
      </div>
    );
  }

  const loading = load?.state === 'loading';

  return (
    <div className="min-w-0 overflow-x-auto" data-table-scroll>
      <table
        data-table-state={loading ? 'loading' : rows.length === 0 ? 'empty' : 'ok'}
        aria-busy={loading || undefined}
        className="w-full border-separate border-spacing-0 text-body"
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {expandable ? (
              <th scope="col" className="h-row w-10 rounded-tl-sm border-b border-line bg-fill-2">
                <span className="sr-only">展开</span>
              </th>
            ) : null}
            {columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                {...(c.width !== undefined ? { style: { width: c.width } } : {})}
                className={cn(
                  'h-row border-b border-line bg-fill-2 px-4 font-medium whitespace-nowrap text-ink',
                  ALIGN[c.align ?? 'left'],
                  i === columns.length - 1 && 'rounded-tr-sm',
                  i === 0 && !expandable && 'rounded-tl-sm',
                )}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 3 }, (_, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 占位骨架没有身份。
              <tr key={r}>
                <td colSpan={span} className="border-b border-line px-4 py-3">
                  <Skeleton className="h-4 w-full" />
                </td>
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={span} className="px-4 py-10 text-center text-ink-3">
                {empty ?? '没有数据'}
              </td>
            </tr>
          ) : (
            rows.flatMap((row, index) => {
              const key = keyOf(row, index);
              const canExpand = expandable !== undefined && (expandable.rowExpandable?.(row) ?? true);
              const expanded = canExpand && open.has(key);
              const selected = selectedKey != null && selectedKey === key;
              const onKey = (e: KeyboardEvent<HTMLTableRowElement>) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onRowClick?.(row);
                }
              };
              const cellCls = cn(
                'border-b border-line px-4 py-3 align-middle whitespace-nowrap text-ink transition-colors',
                selected ? 'bg-brand-1' : 'group-hover/row:bg-fill-1',
                expanded && !selected && 'bg-fill-1',
              );
              const main = (
                <tr
                  key={key}
                  data-row-key={key}
                  data-selected={selected || undefined}
                  {...(selected ? { 'aria-current': true as const } : {})}
                  {...(onRowClick ? { onClick: () => onRowClick(row), onKeyDown: onKey, tabIndex: 0 } : {})}
                  className={cn('group/row', onRowClick && 'cursor-pointer')}
                >
                  {expandable ? (
                    <td className={cn(cellCls, 'w-10 px-2')}>
                      {canExpand ? (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={expanded ? '收起' : '展开'}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            });
                          }}
                          className="inline-flex size-6 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-fill-2 hover:text-ink"
                        >
                          <ChevronRight
                            aria-hidden
                            className={cn(
                              'size-4 transition-transform duration-200',
                              expanded && 'rotate-90',
                            )}
                          />
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                  {columns.map((c) => {
                    const value = (row as Record<string, unknown>)[c.key];
                    return (
                      <td key={c.key} className={cn(cellCls, ALIGN[c.align ?? 'left'])}>
                        {c.render ? c.render(value, row, index) : cellText(value)}
                      </td>
                    );
                  })}
                </tr>
              );
              if (!expanded || !expandable) return [main];
              return [
                main,
                <tr key={`${key}:detail`} data-detail-for={key}>
                  <td
                    colSpan={span}
                    className="animate-in border-b border-line bg-fill-1 px-4 py-3 duration-200 fade-in-0"
                  >
                    {expandable.render(row)}
                  </td>
                </tr>,
              ];
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
