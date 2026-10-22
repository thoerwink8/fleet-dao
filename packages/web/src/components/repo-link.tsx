// 仓库里的 PR、issue：按品牌拼外链；品牌不给链接时只显示文字。

import type { ReactNode } from 'react';
import { brand } from '#brand';
import { TextLink } from './layout/text-link';

export function repoHref(
  repo: { owner: string; name: string },
  kind: 'pull' | 'issues',
  n: number,
): string | undefined {
  return brand.repoLink(repo, kind, n);
}

/**
 * 有外链就是新窗口打开的链接；没有就是一段文字。
 * 不传 className 时按文字链接的样子画（品牌色、等宽数字，#3509）；还在传 className 的老调用处照旧。
 */
export function RepoLink({
  repo,
  kind,
  n,
  className,
  icon,
  children,
}: {
  repo: { owner: string; name: string };
  kind: 'pull' | 'issues';
  n: number;
  className?: string;
  /** 外链标记（箭头）：只在真有外链时显示。 */
  icon?: ReactNode;
  children: ReactNode;
}) {
  const href = repoHref(repo, kind, n);
  if (!href) return <span {...(className !== undefined ? { className } : {})}>{children}</span>;
  if (className === undefined) {
    return (
      <TextLink href={href} external mono>
        {children}
        {icon}
      </TextLink>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
      {icon}
    </a>
  );
}
