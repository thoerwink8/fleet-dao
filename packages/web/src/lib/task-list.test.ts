import { describe, expect, test } from 'vitest';
import {
  backToList,
  detailLink,
  filterOf,
  isFiltered,
  paramsWithView,
  rowStatus,
  viewOfParams,
} from './task-list';

describe('任务列表的筛选 ⇄ 地址栏', () => {
  test('认得的值读出来，不认的状态当没给，搜索词原样留着', () => {
    expect(viewOfParams(new URLSearchParams('status=failed&repo=r1&q=%E7%99%BB%E5%BD%95'))).toEqual({
      status: 'failed',
      repoId: 'r1',
      q: '登录',
    });
    expect(viewOfParams(new URLSearchParams('status=nope'))).toEqual({
      status: undefined,
      repoId: undefined,
      q: '',
    });
  });

  test('回写地址栏：空的键不写，别的参数（?node=）原样留着；接口条件里搜索词两头去空白', () => {
    const prev = new URLSearchParams('node=wsl&status=done&q=old');
    expect(paramsWithView(prev, { status: undefined, repoId: 'r1', q: ' ' }).toString()).toBe(
      'node=wsl&repo=r1',
    );
    expect(filterOf({ status: 'done', repoId: undefined, q: ' #21 ' })).toEqual({ status: 'done', q: '#21' });
    expect(isFiltered({ status: undefined, repoId: undefined, q: '  ' })).toBe(false);
    expect(isFiltered({ status: undefined, repoId: undefined, q: 'x' })).toBe(true);
  });
});

describe('详情页返回', () => {
  test('只认站内的 /tasks 列表地址；别的（别的站、别的页、协议相对地址）一律不认，回主页', () => {
    expect(backToList('/tasks')).toBe('/tasks');
    expect(backToList('/tasks?status=failed&q=a')).toBe('/tasks?status=failed&q=a');
    expect(backToList(null)).toBeNull();
    for (const bad of [
      'https://evil.example/tasks',
      '//evil.example/tasks',
      '/tasks/t-1',
      '/tasksx',
      '/audit',
      '',
    ]) {
      expect(backToList(bad), bad).toBeNull();
    }
  });

  test('点进详情的链接带着列表地址，转义后能原样取回', () => {
    const from = '/tasks?status=failed&q=a b';
    const link = detailLink('t-12', from);
    expect(link).toBe(`/tasks/t-12?from=${encodeURIComponent(from)}`);
    expect(backToList(new URL(link, 'http://x').searchParams.get('from'))).toBe(from);
  });
});

describe('一行的状态', () => {
  test('暂停的单写已暂停（等待色），不画成失败；其余照状态', () => {
    expect(rowStatus({ state: 'running', paused: '已暂停：x' })).toEqual({ tone: 'stall', label: '已暂停' });
    expect(rowStatus({ state: 'failed' })).toMatchObject({ tone: 'fail', label: '失败' });
    expect(rowStatus({ state: 'done' })).toMatchObject({ tone: 'done' });
  });
});
