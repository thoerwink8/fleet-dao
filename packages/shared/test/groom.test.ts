// 临时指挥官整理待办的记录现算和「能不能叫」的判法（母单 #1335 第 3 片，#1338）。
import { describe, expect, it } from 'vitest';
import {
  foldGroomRequests,
  GROOM_ACTION,
  GROOM_AUTO_GAP_MS,
  GROOM_MAX_PER_DAY,
  GROOM_REQUEST_TTL_MS,
  GROOM_RUNNING_LIMIT_MS,
  type GroomAuditRow,
  groomQuota,
  judgeGroomRequest,
} from '../src/groom.ts';

const NOW = new Date('2026-10-08T14:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const row = (
  action: string,
  after: unknown,
  at: Date,
  ok = true,
  error: string | null = null,
): GroomAuditRow => ({
  at,
  action,
  actorId: 'x',
  after,
  ok,
  error,
});
const req = (id: string, at: Date, repo = 'acme/demo', source = 'http') =>
  row(GROOM_ACTION.request, { requestId: id, repo, source }, at);
const start = (id: string, at: Date) => row(GROOM_ACTION.start, { requestId: id }, at);
const result = {
  opened: [],
  amended: [],
  groomed: [],
  suggestedClose: [],
  flagged: [],
  rejected: [],
  summary: 's',
};

describe('foldGroomRequests', () => {
  it('排队 → 在做 → 做完 / 没做成，新的在前', () => {
    const { requests, unreadable } = foldGroomRequests(
      [
        req('q', ago(2 * MIN)),
        req('r', ago(30 * MIN)),
        start('r', ago(29 * MIN)),
        req('d', ago(300 * MIN)),
        start('d', ago(299 * MIN)),
        row(GROOM_ACTION.done, { requestId: 'd', result }, ago(280 * MIN)),
        req('f', ago(400 * MIN)),
        start('f', ago(399 * MIN)),
        row(GROOM_ACTION.done, { requestId: 'f' }, ago(390 * MIN), false, '会话没跑成'),
      ],
      NOW,
    );
    expect(unreadable).toBe(0);
    expect(requests.map((r) => [r.requestId, r.state])).toEqual([
      ['q', 'queued'],
      ['r', 'running'],
      ['d', 'done'],
      ['f', 'failed'],
    ]);
    expect(requests.find((r) => r.requestId === 'f')?.why).toBe('会话没跑成');
    expect(requests.find((r) => r.requestId === 'd')?.result?.summary).toBe('s');
  });

  it('点了太久没人接手 → 作废；接手了太久没回结果 → 当没做成（锁放开）', () => {
    const { requests } = foldGroomRequests(
      [
        req('old', ago(GROOM_REQUEST_TTL_MS + MIN)),
        req('stuck', ago(GROOM_RUNNING_LIMIT_MS + 5 * MIN)),
        start('stuck', ago(GROOM_RUNNING_LIMIT_MS + MIN)),
      ],
      NOW,
    );
    expect(requests.find((r) => r.requestId === 'old')?.state).toBe('expired');
    const stuck = requests.find((r) => r.requestId === 'stuck');
    expect(stuck?.state).toBe('failed');
    expect(stuck?.why).toContain('多半中途重启');
  });

  it('同一毫秒里先写的接手、后写的点击，读回来顺序乱了也不丢', () => {
    const t = ago(MIN);
    const { requests } = foldGroomRequests([start('a', t), req('a', t)], NOW);
    expect(requests[0]?.state).toBe('running');
  });

  it('【故意造出的失败】认不出的记录数进 unreadable，不当没有也不瞎拼', () => {
    const { requests, unreadable } = foldGroomRequests(
      [
        row(GROOM_ACTION.request, { nope: true }, ago(MIN)),
        start('没有对应点击', ago(MIN)),
        row('groom.未知', {}, ago(MIN)),
        req('ok', ago(MIN)),
        row(GROOM_ACTION.done, { requestId: 'ok', result: { 瞎写: 1 } }, ago(MIN / 2)),
      ],
      NOW,
    );
    expect(unreadable).toBe(4);
    expect(requests.map((r) => r.requestId)).toEqual(['ok']);
    expect(requests[0]?.state).toBe('queued'); // 认不出的「做完」不当成做成了
  });
});

describe('judgeGroomRequest', () => {
  const on = { on: true } as const;
  const judge = (rows: GroomAuditRow[], over: Partial<Parameters<typeof judgeGroomRequest>[0]> = {}) =>
    judgeGroomRequest({
      repo: 'acme/demo',
      source: 'http',
      now: NOW,
      requests: foldGroomRequests(rows, NOW).requests,
      engine: on,
      ...over,
    });

  it('顺序：总开关 → 锁 → 每日次数 → 自动叫的间隔', () => {
    expect(judge([], { engine: { on: false, why: '关着' } })).toMatchObject({
      ok: false,
      reason: 'engine_off',
    });
    expect(judge([req('a', ago(MIN))])).toMatchObject({ ok: false, reason: 'busy' });
    const three = [0, 1, 2].flatMap((i) => [
      req(`u${i}`, ago((300 + i) * MIN)),
      start(`u${i}`, ago((299 + i) * MIN)),
      row(GROOM_ACTION.done, { requestId: `u${i}` }, ago((290 + i) * MIN), false, 'x'),
    ]);
    expect(judge(three)).toMatchObject({ ok: false, reason: 'daily_cap' });
    // 总开关关着优先于别的原因
    expect(judge(three, { engine: { on: false, why: '关着' } })).toMatchObject({ reason: 'engine_off' });
  });

  it('自动叫：距上次接手不到间隔不叫；人点的不受间隔管', () => {
    const rows = [
      req('a', ago(GROOM_AUTO_GAP_MS - 10 * MIN)),
      start('a', ago(GROOM_AUTO_GAP_MS - 9 * MIN)),
      row(GROOM_ACTION.done, { requestId: 'a' }, ago(MIN), false, 'x'),
    ];
    expect(judge(rows, { source: 'auto' })).toMatchObject({ ok: false, reason: 'too_soon' });
    expect(judge(rows, { source: 'http' })).toMatchObject({ ok: true });
    const later = [
      req('a', ago(GROOM_AUTO_GAP_MS + 20 * MIN)),
      start('a', ago(GROOM_AUTO_GAP_MS + 19 * MIN)),
      row(GROOM_ACTION.done, { requestId: 'a' }, ago(GROOM_AUTO_GAP_MS + 10 * MIN), false, 'x'),
    ];
    expect(judge(later, { source: 'auto' })).toMatchObject({ ok: true });
  });

  it('接手时（ignoreRequestId）：自己排着队不算占锁，只有正在做的占', () => {
    const rows = [req('me', ago(MIN)), req('other', ago(2 * MIN))];
    expect(judge(rows, { ignoreRequestId: 'me' })).toMatchObject({ ok: true });
    const running = [...rows, start('other', ago(MIN))];
    expect(judge(running, { ignoreRequestId: 'me' })).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('剩余次数：用过几次、还剩几次、上次接手的时刻', () => {
    const rows = [
      req('a', ago(300 * MIN)),
      start('a', ago(299 * MIN)),
      row(GROOM_ACTION.done, { requestId: 'a', result }, ago(280 * MIN)),
    ];
    const q = groomQuota(foldGroomRequests(rows, NOW).requests, 'ACME/demo', NOW);
    expect(q).toMatchObject({ used: 1, remaining: GROOM_MAX_PER_DAY - 1, max: GROOM_MAX_PER_DAY });
    expect(q.lastStartedAt).toBe(ago(299 * MIN).toISOString());
    expect(groomQuota(foldGroomRequests(rows, NOW).requests, 'other/repo', NOW).used).toBe(0);
  });
});
