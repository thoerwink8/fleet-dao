// 系统通知（#2050，方案第七节）：APP 开着、窗口不在前台时，推送里来了新提醒就用 Notification API 弹一条，点一下回对应页。
// 不走谷歌推送（国内 FCM 不稳）；关掉 APP 以后的推送这一版不做。
// 权限只在设置页点「打开系统通知」时才请求，页面加载、收到提醒时都不请求。

export type NotifyPermission = 'unsupported' | 'default' | 'granted' | 'denied';

/** 现在的通知权限；浏览器没有 Notification 写 unsupported（设置页写「读不到」）。 */
export function notifyPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  const p = Notification.permission;
  return p === 'granted' || p === 'denied' || p === 'default' ? p : 'unsupported';
}

/** 请求权限（只给设置页的按钮调）。返回请求之后的权限；没有 Notification 或请求抛错回 unsupported。 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    await Notification.requestPermission();
  } catch {
    return notifyPermission();
  }
  return notifyPermission();
}

/** 窗口在前台：页面可见且有焦点。切到别的窗口、最小化、切走标签页都算不在前台。 */
export function windowInForeground(doc: Pick<Document, 'visibilityState' | 'hasFocus'> = document): boolean {
  return doc.visibilityState === 'visible' && doc.hasFocus();
}

export interface SystemNoticeInput {
  id: string;
  title: string;
  body?: string | undefined;
  /** 站内路径；没有就回通知中心。 */
  link?: string | undefined;
}

/**
 * 弹一条系统通知。已授权、窗口不在前台才弹；返回有没有弹。
 * 点通知：把窗口拉到前台、关掉这条，再 go(站内路径)。同一条提醒用 id 做 tag，重复来不叠。
 */
export function showSystemNotification(
  n: SystemNoticeInput,
  go: (path: string) => void,
  foreground: () => boolean = windowInForeground,
): boolean {
  if (notifyPermission() !== 'granted') return false;
  if (foreground()) return false;
  let shown: Notification;
  try {
    shown = new Notification(n.title, { body: n.body ?? '', tag: n.id });
  } catch {
    // 个别环境（安卓 Chrome 的页面里）禁止直接 new：当没弹成，页面里的 toast 照旧
    return false;
  }
  shown.onclick = () => {
    window.focus();
    shown.close();
    go(n.link ?? '/notifications');
  };
  return true;
}
