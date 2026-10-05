// 卡片：全部 JSON 2.0、共享卡、一个主按钮、只用白名单里的组件、不超 30 KB、不出现内部代号。
// 网关自己画的卡只剩报警卡（意图卡另在 intent-cards.test.ts）；自检器本身也要先证明能抓到违规
// （旧系统的日报卡用了 2.0 不支持的 note 组件，生产上一张都发不出去）。
import { describe, expect, it } from 'vitest';
import { checkCard, type LinkAlert, linkAlertCard, type RenderContext } from '../src/cards.ts';
import type { Card } from '../src/port.ts';
import { clip } from '../src/words.ts';
import { textIn } from './fake-feishu.ts';

const ctx: RenderContext = { publicUrl: 'https://cockpit.example.test', now: Date.now(), nonce: 'n1' };

const down: LinkAlert = {
  since: ctx.now - 6 * 60_000,
  at: ctx.now,
  loops: [{ name: 'intents', lastOkAt: null, lastFail: { at: ctx.now - 30_000, reason: '后端现在连不上' } }],
};

describe('卡片', () => {
  it('报警卡（没通、已通）都过自检：JSON 2.0 共享卡、正好一个主按钮、白名单组件、不超 30 KB、没有内部代号', () => {
    for (const [name, card] of [
      ['没通', linkAlertCard(down, ctx)],
      ['已通', linkAlertCard({ ...down, backAt: ctx.now }, ctx)],
    ] as const) {
      expect({ name, problems: checkCard(card) }).toEqual({ name, problems: [] });
    }
  });

  it('原话里的符号原样显示，不当成格式（动态文字只进 plain_text）', () => {
    const reason = '把 **首页** 改成 <font color=red>红</font> [链接](http://x)';
    const card = linkAlertCard(
      { ...down, loops: [{ ...down.loops[0], lastFail: { at: ctx.now, reason } }] } as LinkAlert,
      ctx,
    );
    expect(textIn(card)).toContain(reason);
    expect(JSON.stringify(card)).not.toContain('"tag":"markdown"');
  });

  it('截断不切在 emoji 中间（半个代理对交给后端，写库时会被换成 � 或整条被拒）', () => {
    expect(clip('a😀b', 3)).toBe('a…');
    expect(clip('😀😀😀', 3)).toBe('😀…');
    expect(clip('ab', 3)).toBe('ab');
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (const s of ['😀'.repeat(50), `x${'😀'.repeat(50)}`]) {
      const out = clip(s, 21);
      expect(out.length).toBeLessThanOrEqual(21);
      expect(lone.test(out)).toBe(false);
    }
  });

  it('自检器能抓到违规：2.0 不支持的 note 组件、两个主按钮、没有主按钮、内部代号、坏回传值、超大卡【故意造出的失败】', () => {
    const good = linkAlertCard(down, ctx);
    const withNote = { ...good, body: { elements: [{ tag: 'note', elements: [] }, ...elementsOf(good)] } };
    expect(checkCard(withNote)).toContain('用了不在白名单里的组件 note');

    const primary = elementsOf(good).at(-1);
    const twoPrimary = { ...good, body: { elements: [...elementsOf(good), primary] } };
    expect(checkCard(twoPrimary)).toContain('主按钮有 2 个，应当正好 1 个');

    const noPrimary = JSON.parse(JSON.stringify(good).replace('primary_filled', 'default'));
    expect(checkCard(noPrimary)).toContain('主按钮有 0 个，应当正好 1 个');

    const leak = JSON.parse(JSON.stringify(good).replace('后端现在连不上', '任务状态 stalled'));
    expect(checkCard(leak).some((p) => p.includes('内部代号'))).toBe(true);

    const badValue = JSON.parse(
      JSON.stringify(good).replace(
        '"behaviors":[{',
        '"behaviors":[{"type":"callback","value":{"a":"board.explode","_n":"n1"}},{',
      ),
    );
    expect(checkCard(badValue).some((p) => p.includes('回传值不认识'))).toBe(true);

    const inflated = { ...good, body: { elements: [...elementsOf(good)] } };
    (inflated.body.elements[0] as { text: { content: string } }).text.content = 'x'.repeat(40_000);
    expect(checkCard(inflated).some((p) => p.includes('超过 30 KB'))).toBe(true);

    const v1 = { ...good, schema: undefined };
    expect(checkCard(v1)).toContain('schema 不是 2.0');
  });
});

function elementsOf(card: Card): unknown[] {
  return (card.body as { elements: unknown[] }).elements;
}
