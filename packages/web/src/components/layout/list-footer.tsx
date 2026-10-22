// 列表底栏（任务列表「加载更多 / 已经到底 / 下一页没读成」）：贴在列表卡最底下，上面一道细线，内容居中。
// 放在 flush 的 Section 里、List 后面；不收 className 和 style。
import type { ReactNode } from 'react';

export function ListFooter({ children }: { children: ReactNode }) {
  return (
    <div data-list-footer className="flex flex-col items-center gap-2 border-t border-line px-section py-3">
      {children}
    </div>
  );
}
