// /healthz 的 feishu_gateway：飞书网关（香港）还来不来。网关的真客户端（packages/feishu 的 createBackend，香港跑的同一份）
// 对着后端长轮询意图卡，通行证验过的才记下；读的时候现算：意图卡轮询 5 分钟没来报红，后端刚起、网关还没来过是「没查成」
// （红，不当成好），没配通行证是「未接」。会随时间自己变红，发布脚本只标待处理（health.test.ts 核对名单）。
import { createBackend } from '@fleet-dao/feishu';
import { IntentRoutes } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  createGatewaySeen,
  feishuGatewayPart,
  GATEWAY_FEISHU_OFF,
  GATEWAY_NO_PASS,
  GATEWAY_SILENT_MS,
  type GatewaySeen,
} from '../src/gateway-seen.ts';
import { type HealthReport, serviceHealthChecks } from '../src/health.ts';
import { GATEWAY_PASS, type Harness, harness, T0 } from './harness.ts';

const SEC = 1_000;
const MIN = 60_000;

/** 别的项都好，只看飞书网关这一项。 */
function healthOf(feishuGateway: Parameters<typeof serviceHealthChecks>[0]['feishuGateway']) {
  return serviceHealthChecks({
    probeDb: async () => {},
    feed: { probe: async () => {} },
    temporal: { check: async () => {}, checkEngine: async () => {} },
    githubEvents: async () => {},
    judge: { check: async () => {} },
    deployLag: { check: async () => {} },
    feishuGateway,
    sessionOrg: async () => {},
    githubApp: async () => {},
    canary: { check: async () => {} },
    engineMaster: { check: async () => {} },
    watchdog: { check: async () => {} },
    nodeReport: { check: async () => {} },
  });
}

/** 网关的真客户端；fetch 直接交给后端的 Hono 应用（不开端口）。 */
function gatewayClient(h: Harness, pass = GATEWAY_PASS) {
  const doFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    h.cockpit.request(input, init)) as typeof fetch;
  return createBackend({ baseUrl: 'http://fleet-api.test', gatewayToken: pass, fetch: doFetch });
}

function setup() {
  let t = T0.getTime();
  const seen = createGatewaySeen(() => new Date(t));
  const h = harness({ gatewaySeen: seen, health: healthOf(seen) });
  return {
    h,
    seen,
    at(ms: number) {
      t = T0.getTime() + ms;
    },
    async report(): Promise<{ status: number; item: HealthReport['checks'][string] | undefined }> {
      const res = await h.cockpit.request('/healthz');
      const body = (await res.json()) as HealthReport;
      return { status: res.status, item: body.checks.feishu_gateway };
    },
  };
}

describe('飞书网关还来不来', () => {
  it('网关的真客户端来长轮询意图卡：记下来，这一项绿，写明几秒前来过', async () => {
    const s = setup();
    const gw = gatewayClient(s.h);
    s.at(20 * SEC);
    await gw.intentCards(0);
    s.at(32 * SEC);
    expect(await s.report()).toEqual({
      status: 200,
      item: { ok: true, message: '意图卡轮询 12 秒前来过' },
    });
  });

  it('通行证不对、没带：请求被拒，不算来过（后端起来 6 分钟了一次都没来：红）', async () => {
    const s = setup();
    const wrong = gatewayClient(s.h, 'not-the-gateway-pass-0123456789abcdef');
    await expect(wrong.intentCards(0)).rejects.toMatchObject({ kind: 'rejected', status: 401 });
    const bare = await s.h.cockpit.request('/api/feishu/intent-cards?waitSeconds=0');
    expect(bare.status).toBe(401);
    s.at(6 * MIN);
    expect(await s.report()).toEqual({
      status: 503,
      item: { ok: false, code: 'silent', message: '后端起来 6 分钟了，意图卡轮询一次都没来过' },
    });
  });

  it('意图卡轮询 5 分钟没来：红，写明多久没来；又来了自己变绿', async () => {
    const s = setup();
    const gw = gatewayClient(s.h);
    await gw.intentCards(0);
    s.at(GATEWAY_SILENT_MS);
    expect((await s.report()).status).toBe(200);
    s.at(GATEWAY_SILENT_MS + SEC);
    expect(await s.report()).toEqual({
      status: 503,
      item: { ok: false, code: 'silent', message: '意图卡轮询 5 分钟没来过' },
    });
    s.at(GATEWAY_SILENT_MS + 30 * SEC);
    await gw.intentCards(0);
    expect(await s.report()).toMatchObject({ status: 200, item: { ok: true } });
  });

  it('后端刚起、网关还没来过：没查成（红），不当成好', async () => {
    const s = setup();
    s.at(12 * SEC);
    expect(await s.report()).toEqual({
      status: 503,
      item: { ok: false, code: 'unchecked', message: '没查成：后端起来才 12 秒，意图卡轮询还没来过' },
    });
  });

  it('【故意造出的失败】#803 这台明说不接飞书（off）：就算通行证在，这一项也报「未接」，不等一个不会来的网关；没写 off 的照旧查', async () => {
    const seen = createGatewaySeen(() => T0);
    const token = 'x'.repeat(40);
    expect(feishuGatewayPart({ feishuOff: true, feishuGatewayToken: token }, seen)).toEqual({
      check: expect.any(Function),
      notWired: GATEWAY_FEISHU_OFF,
    });
    expect(feishuGatewayPart({ feishuOff: false, feishuGatewayToken: null }, seen)).toMatchObject({
      notWired: GATEWAY_NO_PASS,
    });
    // 配了通行证又没说 off：查网关来没来（就是 seen 本身），不报「未接」
    const live = feishuGatewayPart({ feishuOff: false, feishuGatewayToken: token }, seen);
    expect(live).toBe(seen);
    expect('notWired' in live).toBe(false);
    // 走一遍健康页：off 的这台不红（ok、not_wired），不是「没查成」
    const h = harness({
      config: { feishuOff: true, feishuGatewayToken: null },
      health: healthOf(feishuGatewayPart({ feishuOff: true, feishuGatewayToken: token }, seen)),
    });
    const res = await h.cockpit.request('/healthz');
    expect(res.status).toBe(200);
    expect(((await res.json()) as HealthReport).checks.feishu_gateway).toEqual({
      ok: true,
      status: 'not_wired',
      message: GATEWAY_FEISHU_OFF,
    });
  });

  it('没配网关通行证：这一项报「未接」，不算坏', async () => {
    const h = harness({
      config: { feishuGatewayToken: null },
      health: healthOf({ check: async () => {}, notWired: GATEWAY_NO_PASS }),
    });
    const res = await h.cockpit.request('/healthz');
    expect(res.status).toBe(200);
    expect(((await res.json()) as HealthReport).checks.feishu_gateway).toEqual({
      ok: true,
      status: 'not_wired',
      message: GATEWAY_NO_PASS,
    });
  });

  it('只认意图卡轮询：收原话、撤回、补漏游标、卡回执来过也记，但不顶替它（网关在、意图卡那条没在跑照样红）', async () => {
    let t = T0.getTime();
    const seen: GatewaySeen = createGatewaySeen(() => new Date(t));
    seen.saw(IntentRoutes.intakeMessage);
    seen.saw(IntentRoutes.intakeRecall);
    seen.saw(IntentRoutes.cursors);
    seen.saw(IntentRoutes.ackCards);
    t += 6 * MIN;
    await expect(seen.check()).rejects.toMatchObject({ code: 'silent' });
    // 原话还在送来：只多一句进日志的细节，对外照样红
    seen.saw(IntentRoutes.intakeMessage);
    await expect(seen.check()).rejects.toMatchObject({
      code: 'silent',
      detail: '网关还在（收原话在来），意图卡那条没在跑',
    });
  });
});
