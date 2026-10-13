// 应用图标角标（Badging API，#2050，方案第七节）：只在装好的 APP 里显示，Chrome、Edge 81 以上支持。
// 数字大于 0 调 setAppBadge，0 调 clearAppBadge；浏览器不支持就静默跳过，不报错、不弹提示。

/** navigator 上和角标有关的那两个方法（测试里换成假的）。 */
export interface BadgeTarget {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

function defaultTarget(): BadgeTarget | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as unknown as BadgeTarget);
}

/** 这个浏览器有没有角标接口（有 ≠ 一定看得见：没装成 APP 时不显示）。 */
export function badgeSupported(target: BadgeTarget | undefined = defaultTarget()): boolean {
  return typeof target?.setAppBadge === 'function';
}

/**
 * 把数字写到角标。返回有没有真的调到浏览器（不支持、调用被拒都是 false）。
 * 0 和负数、非整数的垃圾值一律清除，不画「0」。
 */
export async function applyAppBadge(
  count: number,
  target: BadgeTarget | undefined = defaultTarget(),
): Promise<boolean> {
  if (!target || !badgeSupported(target)) return false;
  try {
    const n = Number.isFinite(count) ? Math.floor(count) : 0;
    if (n > 0) {
      await target.setAppBadge?.(n);
    } else if (typeof target.clearAppBadge === 'function') {
      await target.clearAppBadge();
    } else {
      // 只有 setAppBadge 没有 clearAppBadge 的浏览器：不带参数的 setAppBadge() 是「亮一个点」，会冒充有件数，所以宁可不动
      return false;
    }
    return true;
  } catch {
    // 没装成 APP、权限被拦：角标只是锦上添花，吞掉
    return false;
  }
}
