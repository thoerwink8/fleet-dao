// 页签对应的内容面板（配 FilterTabs 的 idPrefix）：role=tabpanel，aria-labelledby 指向选中的页签。
// 只画选中那一块；不收 className 和 style。
import type { ReactNode } from 'react';

export function TabPanel({
  idPrefix,
  id,
  children,
}: {
  /** 和 FilterTabs 的 idPrefix 一样。 */
  idPrefix: string;
  /** 现在选中的页签 id。 */
  id: string;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel`} aria-labelledby={`${idPrefix}-${id}`} data-tab-panel={id}>
      {children}
    </div>
  );
}
