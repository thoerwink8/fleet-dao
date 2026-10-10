// @vitest-environment happy-dom
// 额度页顶上的切号现状（#194）：挂着哪个、拼车几点恢复、渠道不可用、只剩 1 个账号、读不到、账本认不出、人叫停——都明说。
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import type { OrgSwitchView } from '../api/types';
import { formatClock } from '../lib/format';
import { OrgSwitchBanner, orgSwitchSummary } from './org-switch';

function renderBanner(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

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

  test('烧速：「按现在的速度约 N 分钟后用满」；20 分钟内用满标黄；最近没在花、已经用满各自明说', () => {
    const live = { live: 'carpool' as const };
    const fast = orgSwitchSummary(
      known({
        ...live,
        burn: { state: 'known', usdPerMinute: 2.5, remainingUsd: 40, minutesLeft: 16, spanMinutes: 10 },
      }),
    );
    expect(fast.details.join('')).toContain('按现在的速度约 16 分钟后用满');
    expect(fast.details.join('')).toContain('每分钟约 $2.50');
    expect(fast.tone).toBe('stall');
    const slow = orgSwitchSummary(
      known({
        ...live,
        burn: { state: 'known', usdPerMinute: 0.5, remainingUsd: 40, minutesLeft: 80, spanMinutes: 10 },
      }),
    );
    expect(slow.tone).toBe('ok');
    const idle = orgSwitchSummary(
      known({
        ...live,
        burn: { state: 'known', usdPerMinute: 0, remainingUsd: 40, minutesLeft: null, spanMinutes: 10 },
      }),
    );
    expect(idle.details.join('')).toContain('没在花');
    const full = orgSwitchSummary(
      known({
        ...live,
        burn: { state: 'known', usdPerMinute: 1, remainingUsd: 0, minutesLeft: 0, spanMinutes: 10 },
      }),
    );
    expect(full.details.join('')).toContain('已经用满');
  });

  test('【故意造出失败】烧速算不出：写「还算不出」和原因，不出现「分钟后用满」，也不出现 0 或猜的数', () => {
    const s = orgSwitchSummary(
      known({ live: 'carpool', burn: { state: 'unknown', why: '最近 15 分钟里算数的读数只有 1 个' } }),
    );
    const text = s.details.join('');
    expect(text).toContain('烧速还算不出：最近 15 分钟里算数的读数只有 1 个');
    expect(text).not.toContain('分钟后用满');
    expect(text).not.toContain('$');
    // 后端没带烧速（老后端、挂着独享）：这一行整个不出现
    expect(orgSwitchSummary(known({ live: 'carpool' })).details.join('')).not.toContain('烧速');
  });

  test('独享到了留量线：顶上说清「独享到留量线，活等拼车恢复」，黄色，小字写哪条线（#194 方案 4.8）', () => {
    const s = orgSwitchSummary(
      known({ soloReserve: { state: 'reached', why: '周额度用了 75%，到了留量线 70%' } }),
    );
    expect(s.headline).toContain('独享到留量线，活等拼车恢复');
    expect(s.tone).toBe('stall');
    expect(s.details.join('')).toContain('周额度用了 75%，到了留量线 70%');
  });

  test('【故意造出失败】留量线读不到 / 认不出：红、写明原因；读数判不了：只写小字、不变色', () => {
    const bad = orgSwitchSummary(
      known({ soloReserve: { state: 'unreadable', why: '设置 engine.quotaReserve 在库里没有' } }),
    );
    expect(bad.tone).toBe('fail');
    expect(bad.details.join('')).toContain('在库里没有');
    const unknown = orgSwitchSummary(
      known({ soloReserve: { state: 'unknown', why: '周额度（线 70%）判不了：读数里没有这个窗口' } }),
    );
    expect(unknown.tone).toBe('ok');
    expect(unknown.details.join('')).toContain('按额度未知照派');
    // 账本读不到时留量线也照样说
    const noLedger = orgSwitchSummary({
      state: 'unavailable',
      why: 'x',
      soloPaused: false,
      soloReserve: { state: 'reached', why: '周额度用了 75%，到了留量线 70%' },
    });
    expect(noLedger.details.join('')).toContain('到了留量线');
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
    // 标题只写一次「只剩 1 个可用账号」；why 里若已带同句只把原因放小字，不再括号套括号
    const single = orgSwitchSummary(
      known({
        channel: {
          state: 'single',
          since: T,
          why: '只剩 1 个可用账号，没得选（共 2 个账号，明确可用 1 个）',
        },
      }),
    );
    expect(single.tone).toBe('stall');
    expect(single.headline).toContain('只剩 1 个可用账号');
    expect(single.headline.match(/只剩 1 个可用账号/g)?.length).toBe(1);
    expect(single.details[0]).toBe('共 2 个账号，明确可用 1 个');
    expect(single.details[0]).not.toContain('只剩 1 个可用账号');
    const unknown = orgSwitchSummary(known({ channel: { state: 'unknown', since: T, why: '接口 503' } }));
    expect(unknown.tone).toBe('stall');
    expect(unknown.details[0]).toContain('读不到账号状态，不切号');
  });

  test('挂着独享、没有拼车恢复条件：一句人话，并链到设置页整池暂停', () => {
    const s = orgSwitchSummary(known({ live: 'solo' }));
    expect(s.headline).toContain('拼车账号被封');
    expect(s.headline).toContain('目前只剩独享');
    expect(s.headline).toContain('要你换新拼车账号');
    expect(s.headline).not.toContain('没有记着的');
    expect(s.headline).not.toContain('恢复条件');
    expect(s.action).toEqual({ to: '/settings#run', label: '整池暂停' });
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
    const { container } = renderBanner(<OrgSwitchBanner view={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  test('画出一句话和小字', () => {
    renderBanner(<OrgSwitchBanner view={known({ whites: 1 })} />);
    expect(screen.getByTestId('org-switch').textContent).toContain('拼车账号被封');
    expect(screen.getByText(/白切）连着 1 次/)).toBeTruthy();
  });

  test('没有拼车恢复条件时画出整池暂停链接', () => {
    renderBanner(<OrgSwitchBanner view={known({ live: 'solo' })} />);
    const link = screen.getByRole('link', { name: '整池暂停' });
    expect(link.getAttribute('href')).toBe('/settings#run');
  });
});
