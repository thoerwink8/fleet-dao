// 文字链接（#3533，样稿里的 `a`）：站内路径走路由（to），站外地址开新窗口（href，末尾可带外链小箭头）。
// 蓝字（brand-ink）用在链接上，悬停变深；不收 className 和 style。手机上点击范围至少 40（伪元素撑开，不改行高）。
// 没有地址的外链（品牌不给链接的仓）调用方自己退回成文字，不用它。
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';

export function TextLink({
  to,
  href,
  mono,
  title,
  children,
  ...aria
}: {
  /** 站内路径（含 #锚点、?参数）。 */
  to?: string;
  /** 站外地址，新窗口打开，末尾画外链小箭头。 */
  href?: string;
  /** 编号、单号：等宽 13。 */
  mono?: boolean;
  title?: string;
  children: ReactNode;
  'aria-label'?: string;
}) {
  const cls = `relative inline-flex items-center gap-0.5 text-brand-ink hover:text-link-hover hover:underline underline-offset-2 after:absolute after:inset-x-0 after:-inset-y-3 md:after:hidden${mono ? ' font-mono text-mono' : ''}`;
  if (href !== undefined) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls} {...(title ? { title } : {})} {...aria}>
        {children}
        <ExternalLink className="size-3" aria-hidden />
      </a>
    );
  }
  return (
    <RouterLink to={to ?? '/'} className={cls} {...(title ? { title } : {})} {...aria}>
      {children}
    </RouterLink>
  );
}
