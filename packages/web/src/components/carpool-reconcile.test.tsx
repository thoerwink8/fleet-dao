// @vitest-environment happy-dom
// 额度页上的拼车额度对账（#194 方案 4.7）：写后端给的那句话、窗口和读数时刻；没法对的写明原因；对得上才是平色，其余是「看一眼」色，永远不是红。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { CarpoolReconcileView } from '../api/types';
import { formatClock } from '../lib/format';
import { CarpoolReconcileBanner, carpoolReconcileSummary } from './carpool-reconcile';

afterEach(cleanup);

const T = '2026-10-04T14:00:00.000Z';
const known = (
  over: Partial<Extract<CarpoolReconcileView, { state: 'known' }>> = {},
): CarpoolReconcileView => ({
  state: 'known',
  windowStart: '2026-10-04T11:00:00.000Z',
  windowEnd: T,
  apiReadAt: '2026-10-04T12:30:00.000Z',
  localUsd: 10,
  apiUsedUsd: 50,
  apiLimitUsd: 80,
  sessions: 3,
  unrecorded: 0,
  unrecordedSwitchStopped: 0,
  gapUsd: 40,
  verdict: 'others',
  note: '这一窗本机记到在拼车上花了 $10.00，接口说用了 $50.00，差 $40.00，多半是别的设备在用',
  ...over,
});

describe('carpoolReconcileSummary', () => {
  test('差得多：整句话照后端写的，是「看一眼」色，不是红；带窗口和读数时刻', () => {
    const s = carpoolReconcileSummary(known());
    expect(s.headline).toContain('多半是别的设备在用');
    expect(s.tone).toBe('stall');
    expect(s.detail).toContain(formatClock('2026-10-04T11:00:00.000Z'));
    expect(s.detail).toContain(formatClock('2026-10-04T12:30:00.000Z'));
  });

  test('对得上：平色', () => {
    expect(carpoolReconcileSummary(known({ verdict: 'match', note: '在误差内' })).tone).toBe('ok');
  });

  test('没记到花费的会话太多说不准、本机记的比接口还多：都是看一眼色', () => {
    expect(carpoolReconcileSummary(known({ verdict: 'unrecorded' })).tone).toBe('stall');
    expect(carpoolReconcileSummary(known({ verdict: 'local_over' })).tone).toBe('stall');
  });

  test('【故意造出的失败】没法对：写明原因、灰色，不冒充对得上', () => {
    const s = carpoolReconcileSummary({ state: 'unavailable', why: '窗口已经过了清零时刻' });
    expect(s.tone).toBe('muted');
    expect(s.headline).toContain('对账看不到：窗口已经过了清零时刻');
    expect(s.headline).not.toContain('对得上');
  });
});

describe('CarpoolReconcileBanner', () => {
  test('没有这项（老后端）不画；有就画出那句话', () => {
    const { container, rerender } = render(<CarpoolReconcileBanner view={undefined} />);
    expect(container.firstChild).toBeNull();
    rerender(<CarpoolReconcileBanner view={known()} />);
    expect(screen.getByTestId('carpool-reconcile').textContent).toContain('接口说用了 $50.00');
    expect(screen.getByTestId('carpool-reconcile').getAttribute('data-tone')).toBe('stall');
  });
});
