// 文字链接（样子照 canvas/fd3.css 的 a：品牌色字，悬停深一档、不带下划线）：行内的链接，单号、PR 号、「看会话」之外的跳转。
// 站内路径走路由，external 开新窗口（rel=noreferrer）。手机上至少 40 高好点。不收 className 和 style。
import type { ReactNode } from 'react';
import { Link } from 'react-router';

const LOOK =
  'rounded-sm text-brand-ink underline-offset-2 transition-colors duration-100 hover:text-link-hover hover:underline focus-visible:ring-2 focus-visible:ring-brand-hover focus-visible:outline-none';

export function TextLink({
  href,
  external,
  mono,
  title,
  children,
  ...aria
}: {
  href: string;
  external?: boolean | undefined;
  /** 编号、分支名这类：等宽数字。 */
  mono?: boolean | undefined;
  title?: string | undefined;
  children: ReactNode;
  'aria-label'?: string;
}) {
  const cls = `${LOOK}${mono ? ' num' : ''}`;
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" title={title} className={cls} {...aria}>
        {children}
      </a>
    );
  }
  return (
    <Link to={href} title={title} className={cls} {...aria}>
      {children}
    </Link>
  );
}
