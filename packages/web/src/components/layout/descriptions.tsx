// 描述列表（参数名照 antd，样子照 canvas/fd3.css 的 .desc；KeyValue 的升级）。键值成对：灰字标签在左，黑字值在右。
// 值收 ReactNode 或 Read<ReactNode>：读失败的那一项自己写灰字「没读到」（悬停给原因），不画成空白、0 或「正常」。
// 窄屏（lg 以下）一律一列。不收 className 和 style。
import type { ReactNode } from 'react';
import { isRead, type Read, UNREAD_TEXT } from '../../lib/read';
import { cn } from '../../lib/utils';

export interface DescriptionsItem {
  label: ReactNode;
  value: ReactNode | Read<ReactNode>;
  /** 值是编号、模型 id、提交号这类：等宽 13。 */
  mono?: boolean;
  /** 值下面的小灰字。 */
  hint?: ReactNode;
}

const COLUMNS = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 lg:grid-cols-2',
  3: 'grid-cols-1 lg:grid-cols-3',
} as const;

export function Descriptions({
  items,
  columns = 3,
}: {
  items: readonly DescriptionsItem[];
  columns?: 1 | 2 | 3;
}) {
  return (
    <dl data-columns={columns} className={cn('grid gap-x-6 gap-y-4', COLUMNS[columns])}>
      {items.map((it, i) => {
        const read = isRead<ReactNode>(it.value) ? it.value : undefined;
        const unread = read !== undefined && !read.ok;
        const value = read ? (read.ok ? read.value : null) : (it.value as ReactNode);
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 标签可以是节点，位置就是这一项的身份。
            key={i}
            className="flex min-w-0 gap-3 text-body"
          >
            <dt className="shrink-0 whitespace-nowrap text-ink-3">{it.label}</dt>
            <dd className="min-w-0 break-words text-ink">
              {unread ? (
                <span title={read.reason} data-unread className="text-ink-3">
                  {UNREAD_TEXT}
                </span>
              ) : it.mono ? (
                <span className="font-mono text-mono">{value}</span>
              ) : (
                value
              )}
              {it.hint ? <span className="block text-meta text-ink-3">{it.hint}</span> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
