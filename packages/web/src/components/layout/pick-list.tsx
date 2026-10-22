// 左列表右详情的「左边」（样子照 canvas/fd3.css 的 .pick .pick-row）。一行：标题加状态在上，灰字说明在下；选中的一行 brand-1 底。
// 放进 Card 的 flush 里用，行之间一道细线。不收 className 和 style。
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/utils';
import type { StatusKey } from '../../theme/status-dict';
import { StatusBadge } from './status-badge';

export interface PickListItem {
  key: string;
  title: ReactNode;
  /** 标题下面的灰字：几次探测、多久前。 */
  meta?: ReactNode;
  /** 行尾的状态（字典键）。 */
  status?: StatusKey;
  /** 给了就是站内链接（可以新窗口打开、复制地址），点它走路由；不给就是按钮，点它调 onChange。 */
  href?: string;
  /** 链接换掉当前历史记录，不压新的一条（href 才有用）。 */
  replace?: boolean;
}

/** 一组 PickList 前面的小标题（「第 1 回合」）：多组并排在同一张卡里时分段用。 */
export function PickGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-pick-group>
      <p className="px-4 pt-3 pb-1 text-meta text-ink-3">{label}</p>
      {children}
    </div>
  );
}

export function PickList({
  items,
  value,
  onChange,
  'aria-label': ariaLabel,
}: {
  items: readonly PickListItem[];
  /** 选中的 key。 */
  value?: string | null | undefined;
  onChange?: (key: string) => void;
  'aria-label'?: string;
}) {
  return (
    <ul {...(ariaLabel ? { 'aria-label': ariaLabel } : {})} className="flex flex-col">
      {items.map((it) => {
        const on = value === it.key;
        const look = cn(
          'flex w-full flex-col gap-0.5 border-b border-line px-4 py-3 text-left text-ink transition-colors',
          on ? 'bg-brand-1' : 'hover:bg-fill-1',
        );
        const body = (
          <>
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate text-body">{it.title}</span>
              {it.status ? <StatusBadge status={it.status} variant="dot" /> : null}
            </span>
            {it.meta ? <span className="min-w-0 truncate text-meta text-ink-3">{it.meta}</span> : null}
          </>
        );
        return (
          <li key={it.key}>
            {it.href !== undefined ? (
              <Link
                to={it.href}
                replace={it.replace === true}
                data-key={it.key}
                {...(on ? { 'aria-current': 'page' as const } : {})}
                className={look}
              >
                {body}
              </Link>
            ) : (
              <button
                type="button"
                data-key={it.key}
                {...(on ? { 'aria-current': true as const } : {})}
                onClick={() => onChange?.(it.key)}
                className={look}
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
