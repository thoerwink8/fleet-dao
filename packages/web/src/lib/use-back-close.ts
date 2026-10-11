// 手机后退键关抽屉（#1820）：抽屉打开时往历史记录里压一条（地址不变），后退只是弹掉这一条、抽屉关，人还留在本页。
// 没有它，手机上按后退键直接离开页面，只有 Esc 能关抽屉。所有 Sheet 共用（components/ui/sheet.tsx 里接上）。
//
// 几条细节：
// - 压记录晚一拍（setTimeout 0）：开发环境 React 会把 effect 先跑一遍再清掉再跑，同步压会多压一条。
// - 叠了两层抽屉时，后退只关最上面一层：每层压的那一条带着自己的号，popstate 时看「现在这条是不是我的」，不是了才算被后退掉。
// - 抽屉是被点叉、Esc、点遮罩关的（不是后退）：自己的那条还在栈顶就补一次 back() 弹掉，免得后退键还要多按一下。
//   如果这时已经跳去别的页（抽屉里的链接），栈顶不是自己的了，就不动。
// - 用 ?run= 这类地址参数自己压了历史的抽屉（任务会话抽屉），在 Sheet 上传 historyEntry={false} 关掉，不重复压。

import { useEffect, useRef } from 'react';

/** 压进 history.state 的记号。 */
export const SHEET_STATE_KEY = 'fleetSheet';

let counter = 0;

export function useBackClose(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    counter += 1;
    const mine = `sheet-${counter}`;
    let pushed = false;

    const push = setTimeout(() => {
      window.history.pushState({ ...(window.history.state ?? {}), [SHEET_STATE_KEY]: mine }, '');
      pushed = true;
    }, 0);

    const onPop = () => {
      if (!pushed) return;
      // 退回来之后栈顶不再是自己的这一条：被后退掉了，关抽屉
      if (window.history.state?.[SHEET_STATE_KEY] !== mine) {
        pushed = false;
        closeRef.current();
      }
    };
    window.addEventListener('popstate', onPop);

    return () => {
      clearTimeout(push);
      window.removeEventListener('popstate', onPop);
      if (!pushed) return;
      // 不是后退关的：等这一拍过去（抽屉里的链接导航会在这一拍内完成），栈顶还是自己的就弹掉
      setTimeout(() => {
        if (window.history.state?.[SHEET_STATE_KEY] === mine) window.history.back();
      }, 0);
    };
  }, [open]);
}
