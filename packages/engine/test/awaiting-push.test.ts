// 等你拍板、引擎问你往飞书推一条（提需求 F1 #2051），每条带驾驶舱链接；每件事只推一次。
// 没配 webhook、没配驾驶舱地址、推不出去、记不下：没查成，不当成推过（推不出去时不记已推）。
import { describe, expect, it } from 'vitest';
import {
  AWAITING_MAX_PER_RUN,
  AWAITING_WINDOW_MS,
  type AwaitingItem,
  awaitingPushKey,
  pushAwaitingMe,
} from '../src/jobs/awaiting-push.ts';
import { cockpitLink } from '../src/jobs/cockpit-link.ts';

const NOW = new Date('2026-10-14T03:00:00Z');
const COCKPIT = 'https://cockpit.example.test';

const decision = (over: Partial<AwaitingItem> = {}): AwaitingItem => ({
  kind: 'decision',
  id: 'n1',
  taskId: 't-uuid-1',
  title: '请批 PR #5',
  detail: '请批 release：PR #5（abc123）。对外发布',
  ...over,
});
const ask = (over: Partial<AwaitingItem> = {}): AwaitingItem => ({
  kind: 'ask',
  id: 'a1',
  taskId: 't-uuid-2',
  title: '登录页要不要保留账密？',
  detail: '',
  ...over,
});

function world(items: readonly AwaitingItem[], cockpitUrl: string | undefined = COCKPIT) {
  const sent: string[] = [];
  const marked: { key: string; title: string; body: string; link: string }[] = [];
  const byKey = new Map<string, string>();
  let sinceSeen: Date | null = null;
  const run = (send?: (text: string) => Promise<void>) =>
    pushAwaitingMe({
      now: () => NOW,
      list: async (since) => {
        sinceSeen = since;
        return items;
      },
      sentBody: async (key) => byKey.get(key) ?? null,
      markSent: async (x) => {
        marked.push({ key: x.dedupeKey, title: x.title, body: x.body, link: x.link });
        byKey.set(x.dedupeKey, x.body);
      },
      send:
        send ??
        (async (text) => {
          sent.push(text);
        }),
      cockpit: (path) => cockpitLink(cockpitUrl, path),
    });
  return { sent, marked, run, since: () => sinceSeen };
}

describe('pushAwaitingMe', () => {
  it('等你拍板、引擎问你各推一条，都带驾驶舱链接（有任务落任务页）；只看最近 24 小时', async () => {
    const w = world([decision(), ask()]);
    const part = await w.run();
    expect(part).toEqual({ scanned: 2, found: 2, unchecked: [] });
    expect(w.sent).toHaveLength(2);
    expect(w.sent[0]).toContain('等你拍板：请批 PR #5');
    expect(w.sent[0]).toContain('驾驶舱：https://cockpit.example.test/tasks/t-uuid-1');
    expect(w.sent[1]).toContain('引擎问你：登录页要不要保留账密？');
    expect(w.sent[1]).toContain('驾驶舱：https://cockpit.example.test/tasks/t-uuid-2');
    expect(w.marked.map((m) => m.key)).toEqual([
      awaitingPushKey('decision', 'n1'),
      awaitingPushKey('ask', 'a1'),
    ]);
    expect(w.marked[0]?.link).toBe('https://cockpit.example.test/tasks/t-uuid-1');
    expect(w.since()?.getTime()).toBe(NOW.getTime() - AWAITING_WINDOW_MS);
  });

  it('没有任务的提醒落在提醒页', async () => {
    const w = world([decision({ taskId: null })]);
    await w.run();
    expect(w.sent[0]).toContain('驾驶舱：https://cockpit.example.test/notifications');
  });

  it('同一件事只推一次：再跑一轮不再推', async () => {
    const w = world([decision()]);
    await w.run();
    const again = await w.run();
    expect(again).toMatchObject({ found: 0, unchecked: [] });
    expect(w.sent).toHaveLength(1);
  });

  it('【故意造出的失败】驾驶舱地址没配：没查成，不推、不记已推', async () => {
    const w = world([decision()], '');
    const part = await w.run();
    expect(part.found).toBe(0);
    expect(part.unchecked.join()).toContain('驾驶舱地址没配');
    expect(w.sent).toEqual([]);
    expect(w.marked).toEqual([]);
  });

  it('【故意造出的失败】飞书推不出去：没查成，不记已推，下一轮再推', async () => {
    const w = world([decision()]);
    const part = await w.run(async () => {
      throw new Error('飞书回了 HTTP 500');
    });
    expect(part).toMatchObject({ found: 0 });
    expect(part.unchecked.join()).toContain('飞书没推成');
    expect(w.marked).toEqual([]);
    const retry = await w.run();
    expect(retry.found).toBe(1);
  });

  it('【故意造出的失败】推出去了但记不下：照实说可能再推一次', async () => {
    const part = await pushAwaitingMe({
      now: () => NOW,
      list: async () => [decision()],
      sentBody: async () => null,
      markSent: async () => {
        throw new Error('库写不进');
      },
      send: async () => {},
      cockpit: (path) => cockpitLink(COCKPIT, path),
    });
    expect(part.found).toBe(1);
    expect(part.unchecked.join()).toContain('没记下');
  });

  it('【故意造出的失败】读不到等你的事：这一部分记 failed，不当成「没有」', async () => {
    const part = await pushAwaitingMe({
      now: () => NOW,
      list: async () => {
        throw new Error('库连不上');
      },
      sentBody: async () => null,
      markSent: async () => {},
      send: async () => {},
      cockpit: (path) => cockpitLink(COCKPIT, path),
    });
    expect(part.failed).toContain('库连不上');
    expect(part).toMatchObject({ scanned: 0, found: 0 });
  });

  it(`一轮最多推 ${AWAITING_MAX_PER_RUN} 条，多出来的照实说下一轮接着推`, async () => {
    const many = Array.from({ length: AWAITING_MAX_PER_RUN + 3 }, (_, i) => decision({ id: `n${i}` }));
    const w = world(many);
    const part = await w.run();
    expect(part.found).toBe(AWAITING_MAX_PER_RUN);
    expect(part.unchecked.join()).toContain('还有 3 件');
    const next = await w.run();
    expect(next.found).toBe(3);
    expect(w.sent).toHaveLength(AWAITING_MAX_PER_RUN + 3);
  });
});

describe('cockpitLink', () => {
  it('拼出某一页的链接：去掉结尾的 /，保留子路径', () => {
    expect(cockpitLink('https://a.example.test/', '/')).toBe('https://a.example.test/');
    expect(cockpitLink(' https://a.example.test/ ', '/quota')).toBe('https://a.example.test/quota');
    expect(cockpitLink('http://localhost:5173', '/tasks/t-1')).toBe('http://localhost:5173/tasks/t-1');
    expect(cockpitLink('https://a.example.test/fleet/', '/france')).toBe(
      'https://a.example.test/fleet/france',
    );
  });

  it.each([
    [undefined, '没配'],
    ['', '没配'],
    ['   ', '没配'],
    ['不是网址', '不认'],
    ['ftp://a.example.test', '不认'],
    [['https://user', 'hunter2@a.example.test'].join(':'), '不认'],
    ['https://a.example.test/?x=1', '不认'],
  ])('【故意造出的失败】%j 抛，写明原因，不带地址', (raw, why) => {
    expect(() => cockpitLink(raw, '/')).toThrow(why);
    try {
      cockpitLink(raw, '/');
    } catch (err) {
      expect(String(err)).not.toContain('hunter2');
    }
  });

  it('页面路径要以 / 开头', () => {
    expect(() => cockpitLink('https://a.example.test', 'quota')).toThrow('以 / 开头');
  });
});
