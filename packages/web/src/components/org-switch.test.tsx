// @vitest-environment happy-dom
// 额度页顶上的切号现状（#194）：挂着哪个、拼车几点恢复、渠道不可用、只剩 1 个账号、读不到、账本认不出、人叫停——都明说。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { OrgSwitchView } from '../api/types';
import { formatClock } from '../lib/format';
import { OrgSwitchBanner, orgSwitchSummary } from './org-switch';

afterEach(cleanup);

const T = '2026-10-04T14:00:00.000Z';
const known = (over: Partial<Extract<OrgSwitchView, { state: 'known' }>> = {}): OrgSwitchView => ({
  state: 'known',
  live: 'solo',
  whites: 0,
  soloPaused: false,
  updatedAt: T,
  ...over,
});

describe('orgSwitchSummary', () => {
  test('挂着独享、记着拼车本人额度用满：写明几点恢复和来源（接口 / 被拒原文）', () => {
    const outage = { kind: 'E1' as const, evidence: '接口说本人额度到顶', since: T, resetsAt: T };
    const api = orgSwitchSummary(known({ outage: { ...outage, resetsFrom: 'api' } }));
    expect(api.headline).toBe(`挂着独享；拼车本人 5 小时额度用满，预计 ${formatClock(T)} 恢复（来源：接口）`);
    expect(api.tone).toBe('ok');
    expect(api.details).toContain('凭什么：接口说本人额度到顶');
    const text = orgSwitchSummary(known({ outage: { ...outage, resetsFrom: 'text' } }));
    expect(text.headline).toContain('来源：被拒原文');
  });

  test('几点恢复不知道也明说，不留空', () => {
    const s = orgSwitchSummary(known({ outage: { kind: 'E2', evidence: '官方窗口', since: T } }));
    expect(s.headline).toContain('几点恢复不知道');
    expect(s.headline).toContain('整辆车的官方窗口被用光');
  });

  test('切回宽限中：说明新活先不往独享派', () => {
    const s = orgSwitchSummary(known({ backPendingSince: T }));
    expect(s.details.join('')).toContain('新活先不往独享派');
  });

  test('【故意造出失败】渠道不可用：红、写明没有一个可用账号；只剩 1 个、读不到状态：黄、写明原因', () => {
    const down = orgSwitchSummary(
      known({ channel: { state: 'unavailable', since: T, why: '共 2 个账号，明确可用 0 个' } }),
    );
    expect(down.tone).toBe('fail');
    expect(down.headline).toContain('渠道不可用');
    expect(down.details[0]).toContain('明确可用 0 个');
    const single = orgSwitchSummary(known({ channel: { state: 'single', since: T, why: '共 2 个账号' } }));
    expect(single.tone).toBe('stall');
    expect(single.details[0]).toContain('只剩 1 个可用账号');
    const unknown = orgSwitchSummary(known({ channel: { state: 'unknown', since: T, why: '接口 503' } }));
    expect(unknown.tone).toBe('stall');
    expect(unknown.details[0]).toContain('读不到账号状态，不切号');
  });

  test('【故意造出失败】连着白切 3 次、最近一次读接口没成、人叫停了：都列出来', () => {
    const s = orgSwitchSummary(
      known({ whites: 3, lastRead: { at: T, ok: false, why: '503' }, soloPaused: true }),
    );
    expect(s.tone).toBe('fail');
    const all = s.details.join('\n');
    expect(all).toContain('连着 3 次');
    expect(all).toContain('已不再自己切回，要人看');
    expect(all).toContain('最近一次读拼车接口没成');
    expect(all).toContain('引擎暂不用独享');
  });

  test('【故意造出失败】账本认不出：红、原话；没接上：灰、写明看不到；都不写成「没事」', () => {
    expect(
      orgSwitchSummary({ state: 'unreadable', why: '切号账本认不出（live：…）', soloPaused: false }),
    ).toMatchObject({
      tone: 'fail',
      headline: '切号账本认不出（live：…）',
    });
    const none = orgSwitchSummary({ state: 'unavailable', why: '没接上', soloPaused: false });
    expect(none.tone).toBe('muted');
    expect(none.headline).toContain('看不到');
  });

  test('还没读到挂的是哪个组织：黄，明说', () => {
    expect(orgSwitchSummary(known({ live: null })).headline).toContain('还没读到');
  });
});

describe('OrgSwitchBanner', () => {
  test('老后端没给这一项：什么都不画', () => {
    const { container } = render(<OrgSwitchBanner view={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  test('画出一句话和小字', () => {
    render(<OrgSwitchBanner view={known({ whites: 1 })} />);
    expect(screen.getByTestId('org-switch').textContent).toContain('挂着独享');
    expect(screen.getByText(/白切）连着 1 次/)).toBeTruthy();
  });
});
