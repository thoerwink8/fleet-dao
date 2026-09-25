// 证据的小工具：字段合并、缺什么、多什么、摘要、每日上限的「今天」从哪算。
import { describe, expect, it } from 'vitest';
import { DELIVERY_MET, FEISHU_INTENT, TRIAGE_KIND, TRIAGE_UI } from '../src/bank.ts';
import { dayStart, digestEvidence, fieldsOf, missingKeys, unknownKeys } from '../src/evidence.ts';

describe('证据', () => {
  it('几道题一起问：字段按第一次出现的顺序去重', () => {
    expect(fieldsOf([TRIAGE_KIND, TRIAGE_UI]).map((f) => f.key)).toEqual(['request']);
    expect(fieldsOf([DELIVERY_MET]).map((f) => f.key)).toEqual(['acceptance', 'changes', 'tests', 'summary']);
  });

  it('必填的没给或全是空白算缺；选填的不给不算', () => {
    expect(missingKeys(DELIVERY_MET, { acceptance: '能登录', changes: ' \n ' })).toEqual(['changes']);
    expect(missingKeys(DELIVERY_MET, { acceptance: '能登录', changes: 'src/login.ts' })).toEqual([]);
  });

  it('哪道题都不认识的字段挑出来', () => {
    expect(unknownKeys([TRIAGE_UI], { request: 'x', requst: 'y' })).toEqual(['requst']);
  });

  it('摘要：长度、哈希、前 200 字；私聊字段不留开头；没给的字段不出现', () => {
    const d = digestEvidence(FEISHU_INTENT.evidence, { message: '进度？', recent_tasks: '额度页' });
    expect(d.message).toEqual({ chars: 3, sha: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(d.recent_tasks?.head).toBe('额度页');
    expect(d.replying_to).toBeUndefined();
  });

  it('「今天」从 UTC 0 点算（和额度读取器里 Jev 池的窗口一致）', () => {
    expect(dayStart(new Date('2026-09-25T00:00:00Z')).toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(dayStart(new Date('2026-09-24T23:59:59Z')).toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(dayStart(new Date('2026-09-25T16:30:00Z')).toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });
});
