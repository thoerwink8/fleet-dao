// 驾驶舱额度页的「拼车额度对账」（carpool-reconcile-view.ts，#194 方案 4.7）：本机记到的花费 vs 接口说的已用；
// 差得多写「多半是别的设备在用」，扣掉没记到花费的会话；读不到、窗口已过、没法估都写明，不拿「对得上」冒充。只显示、不报警。
import { describe, expect, it } from 'vitest';
import { carpoolReconcileView } from '../src/carpool-reconcile-view.ts';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const H = 60 * 60_000;
const api = (used: number | null, over: Record<string, unknown> = {}) => ({
  poolId: 'claude-carpool',
  used,
  limit: 80 as number | null,
  resetsAt: new Date(NOW.getTime() + 2 * H) as Date | null,
  readAt: new Date(NOW.getTime() - 60_000),
  staleSince: null,
  ...over,
});
const spend = (over: Partial<Parameters<typeof carpoolReconcileView>[0] & object>['spend'] = {}) => ({
  sessions: 5,
  recordedUsd: 20,
  recorded: 5,
  unrecorded: 0,
  unrecordedSwitchStopped: 0,
  ...over,
});
const view = (a: ReturnType<typeof api>, s = spend()) => carpoolReconcileView({ api: a, spend: s }, NOW);

describe('carpoolReconcileView', () => {
  it('对得上：写两个数和差额，在误差内', () => {
    const v = view(api(21));
    expect(v).toMatchObject({
      state: 'known',
      verdict: 'match',
      localUsd: 20,
      apiUsedUsd: 21,
      gapUsd: 1,
      windowStart: new Date(NOW.getTime() - 3 * H).toISOString(),
      windowEnd: new Date(NOW.getTime() + 2 * H).toISOString(),
    });
    expect(v.state === 'known' && v.note).toBe(
      '这一窗本机记到在拼车上花了 $20.00，接口说用了 $21.00，差 $1.00，在误差内',
    );
  });

  it('差得多、没有没记到花费的会话：写「多半是别的设备在用」', () => {
    const v = view(api(50));
    expect(v).toMatchObject({ verdict: 'others', gapUsd: 30 });
    expect(v.state === 'known' && v.note).toContain('多半是别的设备在用');
  });

  it('差得多但有没记到花费的会话（切号停下的）：先按已记会话的平均扣掉，扣完不多就不怪别的设备', () => {
    // 5 个已记共 $20、均 $4；另有 3 个没记（2 个切号停下）估 $12；差 $16 里扣掉 $12 还剩 $4，不到线
    const v = view(api(36), spend({ unrecorded: 3, unrecordedSwitchStopped: 2 }));
    expect(v).toMatchObject({ verdict: 'match', unrecorded: 3, unrecordedSwitchStopped: 2 });
    const note = v.state === 'known' ? v.note : '';
    expect(note).toContain('有 3 个会话没记到花费（其中 2 个是切号停下的）');
    expect(note).toContain('按本窗已记会话的平均估 $12.00');
    expect(note).not.toContain('别的设备');
  });

  it('扣掉没记到的以后还差得多：照样写别的设备，并写清扣了多少', () => {
    const v = view(api(60), spend({ unrecorded: 3, unrecordedSwitchStopped: 3 }));
    expect(v).toMatchObject({ verdict: 'others' });
    expect(v.state === 'known' && v.note).toContain(
      '扣掉没记到花费的会话（按本窗已记会话的平均估 $12.00）还差 $28.00，多半是别的设备在用',
    );
  });

  it('【故意造出的失败】有没记到花费的会话、又没有已记会话可估平均：说不准，不往别的设备上猜', () => {
    const v = view(
      api(40),
      spend({ sessions: 2, recorded: 0, recordedUsd: 0, unrecorded: 2, unrecordedSwitchStopped: 2 }),
    );
    expect(v).toMatchObject({ verdict: 'unrecorded', localUsd: 0 });
    const note = v.state === 'known' ? v.note : '';
    expect(note).toContain('说不准是不是别的设备在用');
    expect(note).not.toContain('多半是别的设备在用');
  });

  it('本机记的比接口说的还多：照实写，不说成对得上', () => {
    const v = view(api(10));
    expect(v).toMatchObject({ verdict: 'local_over', gapUsd: -10 });
    expect(v.state === 'known' && v.note).toContain('本机记的比接口说的还多 $10.00');
  });

  it('窗口里一个会话都没有、接口也说没用：对得上（真的都是 0）', () => {
    expect(view(api(0), spend({ sessions: 0, recordedUsd: 0, recorded: 0 }))).toMatchObject({
      state: 'known',
      verdict: 'match',
    });
  });

  it('【故意造出的失败】没读到过窗口、接口没给已用或上限、没给清零时刻、窗口已过：一律 unavailable 写明，不冒充对得上', () => {
    const why = (v: ReturnType<typeof view>) => (v.state === 'unavailable' ? v.why : `不该是 ${v.state}`);
    expect(why(carpoolReconcileView(null, NOW))).toContain('没读到过拼车的 5 小时美元窗口');
    expect(why(view(api(null)))).toContain('没有已用美元或上限');
    expect(why(view(api(10, { limit: null })))).toContain('没有已用美元或上限');
    expect(why(view(api(10, { limit: 0 })))).toContain('没有已用美元或上限');
    expect(why(view(api(10, { resetsAt: null })))).toContain('没给清零时刻');
    expect(why(view(api(10, { resetsAt: new Date(NOW.getTime() - 1) })))).toContain('已经过了清零时刻');
  });
});
