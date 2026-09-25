// 仓库里的 PR、issue：正式驾驶舱给外链，演示版不给（只显示文字，不带任何外链）。

import type { ReactNode } from 'react';
import { brand } from '#brand';

export function repoHref(
  repo: { owner: string; name: string },
  kind: 'pull' | 'issues',
  n: number,
): string | undefined {
  return brand.repoLink(repo, kind, n);
}

/** 有外链就是新窗口打开的链接（末尾带 icon）；没有就是一段文字。 */
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
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
      {icon}
    </a>
  );
}
