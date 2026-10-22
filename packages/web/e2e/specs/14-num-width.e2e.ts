// 字体落系统字体（#3584）后，要对齐的数字靠 `num` 类的 tabular-nums：「111」和「000」量出来宽度必须相等。
import { expect, test } from '../support/fixtures.ts';

test.describe('数字列对齐', () => {
  test('num 类里「111」和「000」一样宽，body 不再全局开等宽数字', async ({ page, problems }) => {
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
    expect(Math.abs(m.w1 - m.w0), `111 宽 ${m.w1}、000 宽 ${m.w0}`).toBeLessThan(0.5);
  });
});
