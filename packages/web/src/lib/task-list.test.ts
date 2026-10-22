import { describe, expect, test } from 'vitest';
import type { TaskListRow } from '../api/types';
import {
  backToList,
  dedupeRows,
  detailLink,
  filterOf,
  isFiltered,
  paramsWithView,
  rowStatusKey,
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
  test('暂停的单归已暂停（等人），不画成在干活或失败；其余照状态取字典键', () => {
    expect(rowStatusKey({ state: 'running', paused: '已暂停：x' })).toBe('task:paused');
    expect(rowStatusKey({ state: 'running' })).toBe('task:running');
    expect(rowStatusKey({ state: 'failed' })).toBe('task:failed');
    expect(rowStatusKey({ state: 'done' })).toBe('task:done');
  });
});

describe('翻页去重', () => {
  const r = (taskId: string, title: string) => ({ taskId, title }) as TaskListRow;
  test('同一张单在两页都出现：只留先出现的那一行，顺序不乱', () => {
    const rows = dedupeRows([
      { items: [r('a', '甲旧'), r('b', '乙')] },
      { items: [r('a', '甲新'), r('c', '丙')] },
    ]);
    expect(rows.map((x) => `${x.taskId}:${x.title}`)).toEqual(['a:甲旧', 'b:乙', 'c:丙']);
  });
});
