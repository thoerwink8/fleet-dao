// 装成 APP（#2050）：读「现在能不能装」。Chrome、Edge 在满足条件时发 beforeinstallprompt，攒下来，设置页的「安装」按钮再用。

/** Chrome、Edge 的可安装事件（TS 的 DOM 库里没有）。 */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  /** 已经是装好的 APP 窗口（独立窗口运行）。 */
  | 'installed'
  /** 浏览器给出了可安装的信号，点「安装」就弹安装框。 */
  | 'available'
  /** 能读到，但现在装不了：已经装过（在浏览器页里打开）、不是 Chrome / Edge，或站点还不满足条件。 */
  | 'unavailable'
  /** 读不到：浏览器没有 service worker（不是 https / localhost，或太老）。 */
  | 'unreadable';

let deferred: InstallPromptEvent | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** 在独立窗口里运行（装好的 APP）。读不到（没有 matchMedia）当 false。 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(display-mode: standalone)').matches;
}

/** 整个应用挂一次：越早越好，beforeinstallprompt 页面一加载就可能来，错过了就没第二次。 */
export function listenForInstall(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onPrompt = (e: Event) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  };
  const onInstalled = () => {
    deferred = undefined;
    emit();
  };
  window.addEventListener('beforeinstallprompt', onPrompt);
  window.addEventListener('appinstalled', onInstalled);
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt);
    window.removeEventListener('appinstalled', onInstalled);
  };
}

export function readInstallState(): InstallState {
  if (isStandalone()) return 'installed';
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unreadable';
  return deferred ? 'available' : 'unavailable';
}

export function subscribeInstall(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 弹安装框。返回用户的选择；没有可用的信号返回 undefined。 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | undefined> {
  const ev = deferred;
  if (!ev) return undefined;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  // 一个事件只能 prompt 一次
  deferred = undefined;
  emit();
  return outcome;
}

/** 测试用：清掉攒下的事件和订阅。 */
export function resetInstallForTest() {
  deferred = undefined;
  listeners.clear();
}
