// 整池暂停到期推飞书（#954）：一条里带池名、原因、去哪撤；同一天同一份正文只推一次。
// 没配、推不出去、记不下：没查成，不当成推过（推不出去时不调用记下）。
import { describe, expect, it } from 'vitest';
import { pushOverduePoolHolds } from '../src/jobs/pool-hold-push.ts';

const NOW = new Date('2026-10-05T04:00:00Z'); // 北京时间 2026-10-05 12:00

const hold = (over: Record<string, unknown> = {}) => ({
  reason: '创始人要大用独享',
  decidedBy: '「法国暂时不用独享号」2026-09-27',
  revokeWhen: '创始人说可以用了',
  reviewBy: '2026-10-30',
  ...over,
});

function world(value: unknown | undefined) {
  const sent: string[] = [];
  const marked: string[] = [];
  let previous: string | null = null;
  const run = (
    send: (text: string) => Promise<void> = async (text) => {
      sent.push(text);
    },
  ) =>
    pushOverduePoolHolds({
      now: () => NOW,
      readSetting: async () => (value === undefined ? { set: false } : { set: true, value }),
      sentBody: async () => previous,
      markSent: async (x) => {
        marked.push(x.body);
        previous = x.body;
      },
      send,
    });
  return { sent, marked, run, setPrevious: (body: string) => (previous = body) };
}

describe('pushOverduePoolHolds', () => {
  it('到期的推一条：池名、原因、去哪撤；没到期的不推；没设过不推', async () => {
    const due = world({
      'claude-solo': hold({ reviewBy: '2026-10-01', owner: '张三' }),
      relay: hold(),
    });
    const part = await due.run();
    expect(part).toMatchObject({ found: 1, unchecked: [] });
    expect(due.sent).toHaveLength(1);
    const text = due.sent[0] ?? '';
    expect(text).toContain('账号池 claude-solo');
    expect(text).toContain('创始人要大用独享');
    expect(text).toContain('张三');
    expect(text).toContain('驾驶舱额度页');
    expect(text).not.toContain('relay');
    expect(due.marked).toEqual([text]);

    const later = world({ relay: hold() });
    expect(await later.run()).toMatchObject({ found: 0, unchecked: [] });
    expect(later.sent).toEqual([]);

    const unset = world(undefined);
    expect(await unset.run()).toEqual({ scanned: 0, found: 0, unchecked: [] });
    expect(unset.sent).toEqual([]);

    const raw = hold() as Record<string, unknown>;
    delete raw.reviewBy;
    const noDate = world({ 'claude-solo': raw });
    expect(await noDate.run()).toMatchObject({ found: 0, unchecked: [] });
    expect(noDate.sent).toEqual([]);
  });

  it('同一天同一份正文只推一次；正文变了（又有池到期）再推', async () => {
    const w = world({ 'claude-solo': hold({ reviewBy: '2026-10-01' }) });
    await w.run();
    const again = await w.run();
    expect(again.found).toBe(0);
    expect(w.sent).toHaveLength(1);

    const more = world({
      'claude-solo': hold({ reviewBy: '2026-10-01' }),
      relay: hold({ reviewBy: '2026-10-05' }),
    });
    more.setPrevious(w.sent[0] ?? '');
    await more.run();
    expect(more.sent).toHaveLength(1);
    expect(more.sent[0]).toContain('relay');
    expect(more.sent[0]).toContain('claude-solo');
  });

  it('【故意造出的失败】飞书没推成：记没查成，不记下「已推」，下一轮还能再推', async () => {
    const w = world({ 'claude-solo': hold({ reviewBy: '2026-10-01' }) });
    const part = await w.run(async () => {
      throw new Error('飞书推送没配，交不出去');
    });
    expect(part.found).toBe(0);
    expect(part.unchecked.join('\n')).toContain('飞书没推成');
    expect(part.unchecked.join('\n')).toContain('没配');
    expect(w.marked).toEqual([]);
    const retried = await w.run();
    expect(retried.found).toBe(1);
    expect(w.sent).toHaveLength(1);
  });

  it('【故意造出的失败】设置认不出：不当成没有到期的，不拿 ok 顶', async () => {
    const w = world('停');
    const part = await w.run();
    expect(part.unchecked.join('\n')).toContain('认不出');
    expect(w.sent).toEqual([]);
    expect(part.found).toBe(0);
  });
});
