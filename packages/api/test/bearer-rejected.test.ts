import { describe, expect, it } from 'vitest';
import { errorCode, harness, viaBearer } from './harness.ts';

// 飞书网关通行证和 fleet 令牌都已撤（决定 0093）：驾驶舱接口只认登录 Cookie，带 Authorization 的一律 401，
// 而且不会退回去认同一个请求里带着的 Cookie。
describe('驾驶舱接口不认 Authorization 令牌', () => {
  it('带 Authorization：401 bearer_not_allowed；同时带着有效 Cookie 也一样，不退回去认 Cookie', async () => {
    const h = harness();
    const { cookie } = await h.login();
    for (const init of [
      viaBearer('GET'),
      { headers: { authorization: 'Basic abc' } },
      { headers: { authorization: 'Bearer wrong-pass', cookie } },
    ]) {
      const res = await h.cockpit.request('/api/me', init);
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('bearer_not_allowed');
    }
  });
});
