import { describe, expect, it } from 'vitest';
import { checkStatusView } from './check-status';

describe('CI 状态词', () => {
  it('排队、在跑、通过、失败，并带上颜色点', () => {
    expect(checkStatusView('QUEUED')).toEqual({ label: '排队中', dot: 'bg-warning' });
    expect(checkStatusView('in_progress').label).toBe('在跑');
    expect(checkStatusView('SUCCESS')).toEqual({ label: '通过', dot: 'bg-success' });
    expect(checkStatusView('failure').label).toBe('失败');
    expect(checkStatusView('failure').dot).toBe('bg-danger');
    expect(checkStatusView('failed').label).toBe('失败');
    expect(checkStatusView('canceled').label).toBe('失败');
    expect(checkStatusView('preparing').label).toBe('排队中');
  });

  it('不认识的状态原样留下', () => {
    expect(checkStatusView('skipped').label).toBe('skipped');
    expect(checkStatusView('locked').label).toBe('locked');
  });

  it('PR 和 MR 跟流水线共用这一张表', () => {
    expect(checkStatusView('opened').label).toBe('开着');
    expect(checkStatusView('OPEN').label).toBe('开着');
    expect(checkStatusView('open').label).toBe('开着');
    expect(checkStatusView('MERGED').label).toBe('已合并');
    expect(checkStatusView('merged').label).toBe('已合并');
    expect(checkStatusView('closed').label).toBe('已关闭');
    expect(checkStatusView('CLOSED').label).toBe('已关闭');
    expect(checkStatusView('draft').label).toBe('草稿');
    expect(checkStatusView('DRAFT').label).toBe('草稿');
    expect(checkStatusView('success').label).toBe('通过');
    expect(checkStatusView('SUCCESS').label).toBe('通过');
  });
});
