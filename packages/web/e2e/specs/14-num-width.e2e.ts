// 字体落系统字体（#3584）后，要对齐的数字靠 `num` 类的 tabular-nums：「111」和「000」量出来宽度必须相等。
// 样式契约（num 开等宽数字、body 不全局开）任何机器都断言；宽度相等只在真落到带等宽数字的字体时断言：
// CI 的 Linux 上栈里的字体一个都没装，落到的兜底字体数字本来就不等宽、也没有 tnum 特性，量宽度没有意义，
// 这时在用例注解里写明落到了哪个字体（不是悄悄跳过）；Windows 落微软雅黑、Mac 落苹方，会真量。
import { expect, test } from '../support/fixtures.ts';

const TABULAR_FAMILIES = ['Microsoft YaHei', 'PingFang SC', 'Inter', 'Segoe UI'];

test.describe('数字列对齐', () => {
  test('num 类开等宽数字、body 不全局开；落到系统字体时「111」和「000」一样宽', async ({
    page,
    context,
    problems,
  }) => {
    for (const s of ['HTTP 401', 'status of 401', 'ERR_ABORTED']) problems.allow(s);
    await page.goto('/login');
    const m = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = '<span id="w1" class="num">111111</span><br><span id="w0" class="num">000000</span>';
      document.body.appendChild(host);
      const w = (id: string) => (document.getElementById(id) as HTMLElement).getBoundingClientRect().width;
      return {
        w1: w('w1'),
        w0: w('w0'),
        numVariant: getComputedStyle(document.getElementById('w1') as HTMLElement).fontVariantNumeric,
        bodyVariant: getComputedStyle(document.body).fontVariantNumeric,
      };
    });
    expect(m.numVariant).toContain('tabular-nums');
    expect(m.bodyVariant, 'body 不全局开等宽数字').not.toContain('tabular-nums');

    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: 0 });
    const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#w1' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
    const family = fonts[0]?.familyName ?? '(无)';
    if (TABULAR_FAMILIES.includes(family)) {
      expect(Math.abs(m.w1 - m.w0), `${family}：111 宽 ${m.w1}、000 宽 ${m.w0}`).toBeLessThan(0.5);
    } else {
      test.info().annotations.push({
        type: '没量宽度',
        description: `落到的字体是 ${family}，不在 ${TABULAR_FAMILIES.join('、')} 里`,
      });
    }
  });
});
