// 整池暂停到期推飞书（#954）：一条里带池名、原因、去哪撤；同一天同一份正文只推一次。
// 没配、推不出去、记不下：没查成，不当成推过（推不出去时不调用记下）。
import { describe, expect, it, vi } from 'vitest';
import { pushOverduePoolHolds } from '../src/jobs/pool-hold-push.ts';
import { FEISHU_WEBHOOK_ENV, feishuWebhookSender, feishuWebhookUrl } from '../src/real/feishu-webhook.ts';

const NOW = new Date('2026-10-05T04:00:00Z'); // 北京时间 2026-10-05 12:00
const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-hook-token-for-logs';

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
    expect(text).toContain('驾驶舱设置页「整池暂停」');
    expect(text).not.toContain('relay');
    expect(due.marked).toEqual([text]);

    const later = world({ relay: hold() });
    expect(await later.run()).toMatchObject({ found: 0, unchecked: [] });
    expect(later.sent).toEqual([]);

    const unset = world(undefined);
    expect(await unset.run()).toEqual({ scanned: 0, found: 0, unchecked: [] });
    expect(unset.sent).toEqual([]);
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
      throw new Error(`飞书推送没配：引擎环境里没有 ${FEISHU_WEBHOOK_ENV}，这条推不出去`);
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

describe('feishuWebhookSender', () => {
  const sender = (env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, attempts = 3) =>
    feishuWebhookSender({ env, fetchImpl, attempts, sleep: async () => {} });

  it('【故意造出的失败】没配、地址不认：抛，话里不带地址，也不去请求', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(sender({}, fetchImpl)('你好')).rejects.toThrow(/没配/);
    expect(fetchImpl).not.toHaveBeenCalled();
    const bad = 'https://evil.example/hook/super-secret-token';
    expect(() => feishuWebhookUrl(bad)).toThrow(/不认/);
    try {
      feishuWebhookUrl(bad);
    } catch (err) {
      expect(String(err)).not.toContain('super-secret-token');
      expect(String(err)).not.toContain('evil.example');
    }
  });

  it('两次失败后成功才算推成；一直失败就抛，抛出的话里不带地址', async () => {
    let n = 0;
    const ok = sender({ [FEISHU_WEBHOOK_ENV]: HOOK }, async () => {
      n += 1;
      if (n < 3) return new Response(JSON.stringify({ code: 19021 }), { status: 200 });
      return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
    });
    await ok('整池暂停到了复查日期');
    expect(n).toBe(3);

    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`connect ${HOOK} refused`);
    });
    await expect(sender({ [FEISHU_WEBHOOK_ENV]: HOOK }, fetchImpl)('正文')).rejects.toThrow(/都没成/);
    try {
      await sender({ [FEISHU_WEBHOOK_ENV]: HOOK }, fetchImpl)('正文');
    } catch (err) {
      expect(String(err)).not.toContain(HOOK);
      expect(String(err)).not.toContain('fake-hook-token-for-logs');
    }
  });
});
