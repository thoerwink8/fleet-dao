// 收件箱读法国账本（#3741 片 2c）：假 fetch 分页读完、30 天截止、已迁/已处理认领、读不到抛 ProgressUnchecked、--from-inbox 新旧编号。
import { describe, expect, it } from 'vitest';
import {
  HANDOFF_ACTION,
  LEDGER_PAGE,
  type LedgerEventsGet,
  ledgerInboxPending,
  liveLedgerEventsGet,
  NOTE_ACTION,
  parseInboxId,
  readAllLedgerEvents,
  readLedgerHandoff,
} from '../src/ledger-read.ts';
import { ProgressRefused, ProgressUnchecked } from '../src/progress.ts';

const REPO = 'o/r';
const NOW = new Date('2026-10-30T00:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

interface Row {
  id: number;
  at: string;
  action: string;
  target: string;
  after: unknown;
  ok?: boolean;
}
const ev = (r: Row) => ({ actorKind: 'api', actorId: 'x', ok: true, ...r });
const handoff = (id: number, daysAgo: number, text = `创始人已选：A（通知 n${id}）`): Row => ({
  id,
  at: day(daysAgo),
  action: HANDOFF_ACTION,
  target: `progress:${REPO}`,
  after: { text },
});
const note = (id: number, text: string): Row => ({
  id,
  at: day(0),
  action: NOTE_ACTION,
  target: `progress:${REPO}`,
  after: { text },
});

/** 假法国：按 after/limit 切片，limit 超过 LEDGER_PAGE 按上限给，记下每次请求 */
function fakeLedger(rows: Row[]) {
  const calls: Array<{ after: number; limit: number }> = [];
  const get: LedgerEventsGet = async ({ after, limit }) => {
    calls.push({ after, limit });
    const events = rows
      .filter((r) => r.id > after)
      .slice(0, Math.min(limit, LEDGER_PAGE))
      .map(ev);
    return { status: 200, text: JSON.stringify({ events, next: events.at(-1)?.id ?? after }) };
  };
  return { get, calls };
}

describe('readAllLedgerEvents', () => {
  it('按 id 往后翻页读完，limit 用上限', async () => {
    const rows: Row[] = Array.from({ length: LEDGER_PAGE * 2 + 3 }, (_, i) => handoff(i + 1, 0));
    const w = fakeLedger(rows);
    const got = await readAllLedgerEvents(w.get);
    expect(got).toHaveLength(rows.length);
    expect(w.calls).toEqual([
      { after: 0, limit: LEDGER_PAGE },
      { after: LEDGER_PAGE, limit: LEDGER_PAGE },
      { after: LEDGER_PAGE * 2, limit: LEDGER_PAGE },
    ]);
  });

  it('刚好整页时再读一页确认读完', async () => {
    const w = fakeLedger(Array.from({ length: LEDGER_PAGE }, (_, i) => handoff(i + 1, 0)));
    expect(await readAllLedgerEvents(w.get)).toHaveLength(LEDGER_PAGE);
    expect(w.calls).toHaveLength(2);
  });

  it('【故意造出的失败】HTTP 非 200、断连、不是 JSON、没有 events、行不对、id 不递增都抛 ProgressUnchecked', async () => {
    const bad: LedgerEventsGet[] = [
      async () => ({ status: 503, text: '{"error":"issue_events_unreadable"}' }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => ({ status: 200, text: '<html>' }),
      async () => ({ status: 200, text: '{"nope":1}' }),
      async () => ({ status: 200, text: JSON.stringify({ events: [{ id: 'x' }] }) }),
      async () => ({
        status: 200,
        text: JSON.stringify({ events: [ev(handoff(5, 0)), ev(handoff(5, 0))] }),
      }),
    ];
    for (const get of bad) await expect(readAllLedgerEvents(get)).rejects.toBeInstanceOf(ProgressUnchecked);
  });
});

describe('ledgerInboxPending', () => {
  it('只收本仓 decision.handoff、最近 30 天、没被认领的（旧到新）', async () => {
    const w = fakeLedger([
      handoff(1, 31), // 超过 30 天
      handoff(2, 29),
      handoff(3, 10),
      { ...handoff(4, 5), target: 'progress:o/other' }, // 别的仓
      { ...handoff(5, 5), ok: false }, // 没成的
      { ...handoff(6, 5), action: 'report.daily' }, // 不是引导
      note(7, '已迁 2：docs/directives/x.md'),
      handoff(8, 1),
      note(9, '已处理 8：记在设计文档'),
      handoff(10, 0),
      note(11, '合了 #12'), // 普通进度不认领
    ]);
    const got = await ledgerInboxPending(REPO, { get: w.get, now: () => NOW });
    expect(got.map((h) => h.id)).toEqual([3, 10]);
    expect(got[0]?.text).toContain('通知 n3');
  });

  it('30 天边界之内的留、之外的不要', async () => {
    const w = fakeLedger([handoff(1, 30.01), handoff(2, 29.99)]);
    expect((await ledgerInboxPending(REPO, { get: w.get, now: () => NOW })).map((h) => h.id)).toEqual([2]);
  });

  it('【故意造出的失败】账本读不到：抛 ProgressUnchecked，不当成收件箱是空的', async () => {
    const get: LedgerEventsGet = async () => ({ status: 401, text: 'no' });
    await expect(ledgerInboxPending(REPO, { get, now: () => NOW })).rejects.toBeInstanceOf(ProgressUnchecked);
  });

  it('【故意造出的失败】待处理行的时间认不出：抛 ProgressUnchecked', async () => {
    const w = fakeLedger([{ ...handoff(1, 1), at: 'yesterday' }]);
    await expect(ledgerInboxPending(REPO, { get: w.get, now: () => NOW })).rejects.toBeInstanceOf(
      ProgressUnchecked,
    );
  });
});

describe('--from-inbox 编号', () => {
  it('新编号（账本行 id）通过；旧的 10 位评论号、非数字、0 都拒绝，旧号的报错给新用法', () => {
    expect(parseInboxId('4137')).toBe(4137);
    expect(() => parseInboxId('4398046511')).toThrowError(ProgressRefused);
    expect(() => parseInboxId('4398046511')).toThrowError(/旧的 #1055 评论号.*progress read --pending/s);
    for (const s of ['0', 'abc', '-3', '1.5', ''])
      expect(() => parseInboxId(s)).toThrowError(ProgressRefused);
  });

  it('readLedgerHandoff：待处理的读出来；已迁、不存在的拒绝', async () => {
    const w = fakeLedger([handoff(3, 2), handoff(4, 2), note(5, '已迁 4：x')]);
    const deps = { get: w.get, now: () => NOW };
    expect((await readLedgerHandoff(3, REPO, deps)).id).toBe(3);
    await expect(readLedgerHandoff(4, REPO, deps)).rejects.toBeInstanceOf(ProgressRefused);
    await expect(readLedgerHandoff(99, REPO, deps)).rejects.toBeInstanceOf(ProgressRefused);
  });
});

describe('liveLedgerEventsGet', () => {
  it('GET /api/nodes/events?after=&limit=，通行证放头里；断连时错误信息不带通行证', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchOk = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return new Response('{"events":[],"next":0}', { status: 200 });
    }) as unknown as typeof fetch;
    const endpoint = () => ({ url: 'http://fr.example/', token: 'SECRET-TOKEN' });
    const r = await liveLedgerEventsGet(endpoint, fetchOk)({ after: 7, limit: 500 });
    expect(r.status).toBe(200);
    expect(seen[0]?.url).toBe('http://fr.example/api/nodes/events?after=7&limit=500');
    expect(seen[0]?.headers['X-Fleet-Node-Token']).toBe('SECRET-TOKEN');
    const fetchBad = (async () => {
      throw new Error('connect failed SECRET-TOKEN');
    }) as unknown as typeof fetch;
    await expect(liveLedgerEventsGet(endpoint, fetchBad)({ after: 0, limit: 1 })).rejects.toThrowError(
      /^((?!SECRET-TOKEN).)*$/s,
    );
  });

  it('【故意造出的失败】读不到地址/通行证配置：抛出，由读方认成没查成', async () => {
    const get = liveLedgerEventsGet(() => {
      throw new Error('读不到 config.json');
    });
    await expect(readAllLedgerEvents(get)).rejects.toBeInstanceOf(ProgressUnchecked);
  });
});
