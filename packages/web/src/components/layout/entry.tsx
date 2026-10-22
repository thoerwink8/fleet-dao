// 入口格（样子照 canvas/fd3.css 的 `.entry`，法国页「更多」用，#3533）：一块浅灰底，左边图标，右边标题加一行灰字，可带一个标签。
// 给 href 是站内链接（整块可点）；给 onClick 是按钮（展开一段内容用，传 expanded 读屏念展开收起）。放在 EntryGrid 里四个一排，窄屏两个一排。
// 标签只给异常（橙、红）。不收 className 和 style。
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Tag, type TagTone } from './tag';

const SHAPE =
  'flex w-full min-w-0 items-center gap-3 rounded-md bg-fill-1 p-4 text-left text-ink outline-none transition-colors duration-100 hover:bg-fill-2 focus-visible:ring-2 focus-visible:ring-brand-hover';

export function Entry({
  icon: Icon,
  title,
  meta,
  tag,
  tagTone,
  href,
  onClick,
  expanded,
}: {
  icon: LucideIcon;
  title: string;
  /** 标题下面的一行灰字。 */
  meta?: ReactNode;
  /** 标题下面的小标签（「失败 1」）。 */
  tag?: ReactNode;
  tagTone?: TagTone;
  /** 整块是站内链接。 */
  href?: string | undefined;
  /** 整块是按钮。 */
  onClick?: (() => void) | undefined;
  /** 按钮展开着没有（只有 onClick 时才有意义）。 */
  expanded?: boolean | undefined;
}) {
  const body = (
    <>
      <Icon aria-hidden className="size-4 shrink-0 text-ink-3" />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-medium text-body">{title}</span>
        {tag ? (
          <span className="flex flex-wrap gap-1">
            <Tag {...(tagTone ? { tone: tagTone } : {})}>{tag}</Tag>
          </span>
        ) : null}
        {meta ? <span className="text-meta text-ink-3">{meta}</span> : null}
      </span>
    </>
  );
  if (href !== undefined) {
    return (
      <Link to={href} data-entry className={SHAPE}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" data-entry aria-expanded={expanded} onClick={() => onClick?.()} className={SHAPE}>
      {body}
    </button>
  );
}

/** 入口排成一块：四个一排，窄屏两个一排。 */
export function EntryGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}
