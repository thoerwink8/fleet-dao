// PWA 的 React 钩子（#2050）：角标的数字来源、角标同步、安装状态。
import { useEffect, useSyncExternalStore } from 'react';
import { useNotifications } from '../../api/client';
import { pendingCount } from '../notice-count';
import { applyAppBadge } from './badge';
import { type InstallState, readInstallState, subscribeInstall } from './install';

/**
 * 角标上该显示的数字。口子在这里：现在接通知中心的「待处理」数（要你拍 + 卡住报警，和铃铛、侧栏同一口径）；
 * 母单 #2047 的 A、D 片合了、有「等我的」件数之后，只改这一个函数的返回值，角标同步和设置页都不用动。
 * 返回 undefined = 还没读到（读失败、读取中）：角标保持原样，不当成 0 清掉。
 */
export function useBadgeCount(): number | undefined {
  const { data } = useNotifications('open');
  return data ? pendingCount(data.counts) : undefined;
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
