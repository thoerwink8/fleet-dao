// 面包屑（= Arco 的 Breadcrumb，样稿 canvas/fd3.css `.crumb`）：页头标题上面一行「驾驶舱 / 任务 / #3491」。
// 最后一项是当前页（aria-current=page，不是链接）；前面的带 href 就是站内链接。分隔的斜杠 ink-3，不读给读屏。
// 放进 Page 的 breadcrumb 槽位用；Page 已经包了 nav 和字号，这里只排列表。不收 className 和 style。
import { Link } from 'react-router';

export interface BreadcrumbItem {
  label: string;
  /** 站内路径；不给就是纯文字（当前页，或没有去处的层级）。 */
  href?: string;
  /** 链接的无障碍名字（不写就用 label）。 */
  ariaLabel?: string;
}

export function Breadcrumb({ items }: { items: readonly BreadcrumbItem[] }) {
  return (
    <ol data-breadcrumb className="flex flex-wrap items-center gap-2">
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 面包屑按位置排，同名两级也要分得开。
          <li key={`${i}:${it.label}`} className="flex items-center gap-2">
            {i > 0 ? (
              <span aria-hidden className="text-ink-3">
                /
              </span>
            ) : null}
            {it.href !== undefined && !last ? (
              <Link
                to={it.href}
                {...(it.ariaLabel ? { 'aria-label': it.ariaLabel } : {})}
                className="inline-flex max-md:min-h-10 max-md:items-center"
              >
                {it.label}
              </Link>
            ) : (
              <span
                {...(last ? { 'aria-current': 'page' as const } : {})}
                className={last ? 'num' : undefined}
              >
                {it.label}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
