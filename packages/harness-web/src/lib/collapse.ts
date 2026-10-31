// 会话列表里「做完」组的折叠状态：默认折叠，点开后记在 localStorage。读写都包 try/catch——
// 隐私模式、被禁用、配额满都会抛，抛了就当没存过（读）或不存（写），页面照常能用。

export const DONE_COLLAPSED_KEY = 'fleet.next.sessions.done-collapsed';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** 做完组是不是折叠的：没存过或读不到 = 折叠（默认）；只有明确存了 '0' 才是展开。 */
export function readDoneCollapsed(storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(DONE_COLLAPSED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeDoneCollapsed(
  collapsed: boolean,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(DONE_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // 存不了就算了：这次点开只在本次页面里有效
  }
}
