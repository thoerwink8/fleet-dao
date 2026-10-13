// 系统通知（#2050）：前台不弹、后台弹、点击回对应页；权限只在明确请求时才问。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  notifyPermission,
  requestNotifyPermission,
  showSystemNotification,
  windowInForeground,
} from './notify';

interface FakeNotification {
  title: string;
  options: NotificationOptions | undefined;
  onclick: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

let created: FakeNotification[];
let permission: string;
const requestPermission = vi.fn(async () => {
  permission = 'granted';
  return 'granted';
});

beforeEach(() => {
  created = [];
  permission = 'granted';
  requestPermission.mockClear();
  class N {
    static get permission() {
      return permission;
    }
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    close = vi.fn();
    title: string;
    options: NotificationOptions | undefined;
    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
      created.push(this as unknown as FakeNotification);
    }
  }
  vi.stubGlobal('Notification', N);
  vi.stubGlobal('window', { focus: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const notice = { id: 'n1', title: '要你拍：发版', body: '选一个', link: '/tasks/12' };

describe('showSystemNotification', () => {
  test('窗口在前台不弹', () => {
    const go = vi.fn();
    expect(showSystemNotification(notice, go, () => true)).toBe(false);
    expect(created).toHaveLength(0);
  });

  test('窗口不在前台就弹，带标题、正文、按提醒编号去重的 tag', () => {
    expect(showSystemNotification(notice, vi.fn(), () => false)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe('要你拍：发版');
    expect(created[0]?.options).toMatchObject({ body: '选一个', tag: 'n1' });
  });

  test('点一下：窗口拉到前台、关掉这条、跳到提醒的站内路径', () => {
    const go = vi.fn();
    showSystemNotification(notice, go, () => false);
    created[0]?.onclick?.();
    expect(window.focus).toHaveBeenCalled();
    expect(created[0]?.close).toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith('/tasks/12');
  });

  test('提醒没带 link 就回通知中心', () => {
    const go = vi.fn();
    showSystemNotification({ id: 'n2', title: 't' }, go, () => false);
    created[0]?.onclick?.();
    expect(go).toHaveBeenCalledWith('/notifications');
  });

  test('没授权（还没问、被拒）不弹，也不去请求权限', () => {
    for (const p of ['default', 'denied']) {
      permission = p;
      expect(showSystemNotification(notice, vi.fn(), () => false)).toBe(false);
    }
    expect(created).toHaveLength(0);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test('浏览器没有 Notification：不弹、不抛错', () => {
    vi.stubGlobal('Notification', undefined);
    expect(showSystemNotification(notice, vi.fn(), () => false)).toBe(false);
  });
});

describe('权限', () => {
  test('读权限不会触发请求', () => {
    expect(notifyPermission()).toBe('granted');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test('只有调 requestNotifyPermission 才请求', async () => {
    permission = 'default';
    expect(await requestNotifyPermission()).toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  test('没有 Notification 写 unsupported', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(notifyPermission()).toBe('unsupported');
    expect(await requestNotifyPermission()).toBe('unsupported');
  });
});

describe('windowInForeground', () => {
  test('可见且有焦点才算前台', () => {
    expect(windowInForeground({ visibilityState: 'visible', hasFocus: () => true })).toBe(true);
    expect(windowInForeground({ visibilityState: 'visible', hasFocus: () => false })).toBe(false);
    expect(windowInForeground({ visibilityState: 'hidden', hasFocus: () => false })).toBe(false);
  });
});
