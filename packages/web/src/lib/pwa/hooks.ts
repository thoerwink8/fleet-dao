// PWA 的 React 钩子（#2050）：角标的数字来源、角标同步、安装状态。
import { useEffect, useSyncExternalStore } from 'react';
import { useRequestTodoCount } from '../../api/client';
import { applyAppBadge } from './badge';
import { type InstallState, readInstallState, subscribeInstall } from './install';

/**
 * 角标上该显示的数字：提需求「等我的」件数（等我拍板、引擎在问我、有我没读的新消息；方案第七节，#2062）。
 * 和提需求页「等我的 N」同一份数（进行中、全部那一份列表的 counts.todo）。
 * 返回 undefined = 还没读到（读失败、读取中、后端没接上需求表）：角标保持原样，不当成 0 清掉。
 */
export function useBadgeCount(): number | undefined {
  return useRequestTodoCount();
}

/** 数字一变就写到应用图标角标：大于 0 显示，0 清除；不支持的浏览器什么也不做。 */
export function useAppBadge(count: number | undefined): void {
  useEffect(() => {
    if (count === undefined) return;
    void applyAppBadge(count);
  }, [count]);
}

/** 能不能装成 APP（随 beforeinstallprompt、appinstalled 更新）。 */
export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribeInstall, readInstallState, () => 'unreadable' as const);
}
