// 时间线（样子照 canvas/fd3.css 的 .timeline .tl-item；设计稿的 Tokens 页有样稿）。
// 左边一列状态点连一根细线，右边标题加灰字时间和说明。点的颜色按状态字典的等级（level）：
// 走过 success、在走 processing、卡住 warning、没成 error、没到 default。不收 className 和 style。
import type { ReactNode } from 'react';
import type { Level } from '../../theme/status-dict';
import { LevelDot } from './status-badge';

export interface TimelineItem {
  /** 时间或日期，灰字。 */
  time?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** 点的等级；不写＝default（灰点）。 */
  status?: Level;
}

export function Timeline({ items }: { items: readonly TimelineItem[] }) {
  return (
    <ol className="flex flex-col">
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: 时间线的身份就是顺序。
            key={i}
            data-status={it.status ?? 'default'}
            className="flex gap-3"
          >
            <span aria-hidden className="flex w-1.5 shrink-0 flex-col items-center pt-2">
              <LevelDot level={it.status ?? 'default'} />
              {last ? null : <span className="mt-1 w-0.5 flex-1 bg-line" />}
            </span>
            <span className={last ? 'flex min-w-0 flex-col gap-0.5' : 'flex min-w-0 flex-col gap-0.5 pb-4'}>
              <span className="text-body break-words text-ink">{it.title}</span>
              {it.time ? <span className="text-meta text-ink-3">{it.time}</span> : null}
              {it.description ? (
                <span className="text-meta break-words text-ink-2">{it.description}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
