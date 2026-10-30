// 创始人引导按周汇总（#3764，决定 0123）：只有意思、没有原话；周号按北京时间 ISO 周；同样的账本出同样的字。
import { describe, expect, it } from 'vitest';
import { digestPath, isoWeekOf, renderDigest, weekRange } from '../src/directive-digest.ts';
import { DirectiveRefused } from '../src/directives.ts';
import { directiveOfEvent, type LedgerDirective } from '../src/ledger-read.ts';

const d = (over: Partial<LedgerDirective>): LedgerDirective => ({
  id: 1,
  at: '2026-10-28T02:00:00Z',
  issue: 3764,
  text: '（原话-secret）',
  meaning: '会话先读规矩再动手',
  category: 'ai',
  owner: 'dir-a',
  spokenAt: '2026-10-28 10:00 +0800',
  ...over,
});

describe('周号', () => {
  it('北京时间 ISO 周：周日深夜算本周，周一零点算下周；跨年按周四所在年', () => {
    expect(isoWeekOf(new Date('2026-10-28T02:00:00Z'))).toBe('2026-W44');
    expect(isoWeekOf(new Date('2026-11-01T15:59:00Z'))).toBe('2026-W44'); // 北京 11-01 23:59 周日
    expect(isoWeekOf(new Date('2026-11-01T16:00:00Z'))).toBe('2026-W45'); // 北京 11-02 00:00 周一
    expect(isoWeekOf(new Date('2026-12-31T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeekOf(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  });

  it('weekRange：周一到周日；写错的周号拒绝', () => {
    expect(weekRange('2026-W44')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(() => weekRange('2026-44')).toThrow(DirectiveRefused);
    expect(() => weekRange('2026-W00')).toThrow(DirectiveRefused);
    expect(() => weekRange('2027-W53')).toThrow(/没有这一周/);
    expect(digestPath('2026-W44')).toBe('docs/directive-digest/2026-W44.md');
  });
});

describe('renderDigest', () => {
  it('只列那一周的、按账本行排；每行时间、类别、挂的单、意思；输出里没有原话', () => {
    const text = renderDigest('2026-W44', [
      d({ id: 2, meaning: '第二条', spokenAt: '2026-10-29 09:00 +0800', text: '原话B-secret' }),
      d({ id: 1, text: '原话A-secret' }),
      d({ id: 3, spokenAt: '2026-11-02 09:00 +0800', meaning: '下一周的' }),
    ]);
    expect(text).toContain('# 创始人引导周汇总 2026-W44');
    expect(text).toContain('- 周期：2026-10-26 至 2026-11-01（北京时间）');
    expect(text).toContain('- 共 2 条');
    expect(text.indexOf('会话先读规矩再动手')).toBeLessThan(text.indexOf('第二条'));
    expect(text).toContain('| 2026-10-28 10:00 | ai | #3764 | 会话先读规矩再动手 |');
    expect(text).not.toContain('下一周的');
    expect(text).not.toContain('secret');
    expect(renderDigest('2026-W44', [d({ id: 1 })])).toBe(renderDigest('2026-W44', [d({ id: 1 })]));
  });

  it('意思里的竖线和换行压平；没有意思的老行不列但说明数目；空周写没有', () => {
    const t = renderDigest('2026-W44', [d({ meaning: 'a|b\nc' }), d({ id: 2, meaning: '' })]);
    expect(t).toContain('| a／b c |');
    expect(t).toContain('（另有 1 条没有写意思，不列）');
    expect(renderDigest('2026-W44', [])).toContain('这一周没有记引导。');
  });

  it('【故意造出的失败】意思里整句抄着原话：拒绝生成，说是哪几行', () => {
    const quote = '这是一句够长的原话内容';
    expect(() => renderDigest('2026-W44', [d({ id: 9, text: quote, meaning: `他说：${quote}` })])).toThrow(
      /账本行 9 的意思里含着原话/,
    );
    // 对外仓：意思就是原文本身（已换成意思），不算抄
    expect(renderDigest('2026-W44', [d({ id: 9, text: quote, meaning: quote })])).toContain(quote);
  });
});

describe('directiveOfEvent', () => {
  const ev = (over: Record<string, unknown>) => ({
    id: 5,
    at: '2026-10-28T02:00:00Z',
    actorKind: 'agent',
    actorId: 'node:x',
    action: 'directive',
    target: 'issue:o/r#3764',
    ok: true,
    after: { text: 't', meaning: 'm', category: 'ai', owner: 'dir-a', spokenAt: '2026-10-28 10:00 +0800' },
    ...over,
  });
  it('本仓的 directive 行读成引导；别的仓、别的 action、失败行是 null', () => {
    expect(directiveOfEvent(ev({}), 'O/R')).toMatchObject({
      id: 5,
      issue: 3764,
      meaning: 'm',
      owner: 'dir-a',
    });
    expect(directiveOfEvent(ev({ target: 'issue:o/other#3' }), 'o/r')).toBeNull();
    expect(directiveOfEvent(ev({ action: 'progress.note' }), 'o/r')).toBeNull();
    expect(directiveOfEvent(ev({ ok: false }), 'o/r')).toBeNull();
    expect(directiveOfEvent(ev({ target: 'progress:o/r' }), 'o/r')).toBeNull();
  });
});
