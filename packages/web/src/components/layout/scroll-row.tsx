// 一行不折、放不下就横滑的筛选行（列表上面的第二层筛选）：手机上右端渐隐提示还能往右滑。不收 className 和 style。
import type { CSSProperties, ReactNode } from 'react';

export function ScrollRow({ children }: { children: ReactNode }) {
  return (
    <div
      data-scroll-row
      style={{ '--fade-end': '1.5rem' } as CSSProperties}
      className="scrollbar-thin flex items-center gap-2 overflow-x-auto whitespace-nowrap max-md:fade-edges-x"
    >
      {children}
    </div>
  );
}
