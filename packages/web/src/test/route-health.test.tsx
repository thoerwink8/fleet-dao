// @vitest-environment happy-dom
// 路由在线状态（#129）：换模型对话框里选不了的原因照探针写的说——走路由两层「接得上」那一件（#574，后端现算、前端不再判）：
// 还没探过的是「不知道」、也选不了，探了没通的写探针的原话；在线的选得了。
import { describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { routeOptions } from '../components/task-actions';

describe('换模型对话框：选不了的原因照探针写的说', () => {
  test('还没探过的写「接不接得上还不知道」，探了没通的照探针的原话，在线的选得了', async () => {
    const api = createMockApi({ live: false });
    const long = `连探两次都没通：${'很长的报错'.repeat(30)}`;
    const st = api.state();
    st.routes = st.routes.map((x) => {
      if (x.id === 'r-ca-opus') {
        const { probe: _probe, ...rest } = x;
        return { ...rest, alive: false };
      }
      if (x.id === 'r-cb-opus')
        return { ...x, alive: false, probe: { state: 'failed', at: new Date().toISOString(), detail: long } };
      return x;
    });
    const execute = (await api.routingLayers()).purposes.find((p) => p.purpose === 'execute');
    if (!execute) throw new Error('假数据的路由两层里没有写码用途');
    const byId = new Map(routeOptions(execute, undefined, undefined).map((o) => [o.id, o]));
    expect(byId.get('r-ca-opus')?.blocked).toBe('接不接得上还不知道：探针还没看过这条路由');
    // 原因整句留着（对话框里显示时截短、悬停看全文，见 route-picker.test.tsx）
    expect(byId.get('r-cb-opus')?.blocked).toBe(`探针判不在线：${long}`);
    expect(byId.get('r-rl-kimi')?.blocked).toBeUndefined();
  });
});
