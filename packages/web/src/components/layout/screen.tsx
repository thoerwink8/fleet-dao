// 整屏版式（#3533）：Screen 是外壳之外的整屏一句话（顶层出错页）：标志、标题（h1）、说明、下面的操作，居中，最宽 448；
// BareFrame 是不带外壳的页的外框（弹出到新窗口的会话）：整屏高、纵向排、页底色、里面自己滚。不收 className 和 style。
import type { ReactNode } from 'react';
import { Title } from './title';

export function Screen({
  mark,
  title,
  actions,
  children,
}: {
  mark?: ReactNode;
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="grid h-dvh place-items-center bg-page p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        {mark}
        <Title level={1} look={2}>
          {title}
        </Title>
        {children}
        {actions}
      </div>
    </main>
  );
}

export function BareFrame({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh flex-col overflow-hidden bg-page">{children}</div>;
}
