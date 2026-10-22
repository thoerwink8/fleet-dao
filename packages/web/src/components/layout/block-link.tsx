// 整块是链接的卡片内容（#3533，在跑的卡片）：站内路径走路由（to），站外地址开新窗口（href），都没有就是个不可点的块。
// 悬停整块 fill-1，键盘聚焦画品牌色圈；里面竖排，行间 4，内边距 12/8。不收 className 和 style。
import type { ReactNode } from 'react';
import { Link } from 'react-router';

const BASE = 'flex h-full min-w-0 flex-col justify-between gap-1 px-3 py-2 text-left text-ink outline-none';
const CLICK =
  'cursor-pointer transition-colors duration-100 hover:bg-fill-1 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-hover';

export function BlockLink({
  to,
  href,
  title,
  label,
  children,
}: {
  /** 站内路径。 */
  to?: string | undefined;
  /** 站外地址，新窗口打开。 */
  href?: string | undefined;
  /** 悬停提示。 */
  title?: string | undefined;
  /** 读屏名字（里面只有图标时给）。 */
  label?: string | undefined;
  children: ReactNode;
}) {
  const aria = label ? { 'aria-label': label } : {};
  const hover = title ? { title } : {};
  if (to !== undefined) {
    return (
      <Link to={to} {...hover} {...aria} className={`${BASE} ${CLICK}`}>
        {children}
      </Link>
    );
  }
  if (href !== undefined) {
    return (
      <a href={href} target="_blank" rel="noreferrer" {...hover} {...aria} className={`${BASE} ${CLICK}`}>
        {children}
      </a>
    );
  }
  return (
    <div {...hover} className={BASE}>
      {children}
    </div>
  );
}
