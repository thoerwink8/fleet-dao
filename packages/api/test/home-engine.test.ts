// 主页「引擎」那一格读真实健康（#902 D7）：开着的要真探到在线的工人才写「正常」；探不到、连不上写 down（红）；
// 压根没有探针写 unknown（没查成）；这台机器按设置没开引擎写 off（已停用，不是红）。
// 每一种「没查成 / 探不到」的路径都故意造一次，看它不被写成 on。
import { HomeResponseSchema, WEB_API_PREFIX, WebRoutes } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { PublicHealthError } from '../src/health.ts';
import { ENGINE_OFF_DETAIL, engineHealthProbe } from '../src/home-engine.ts';
import type { HealthCheck, Logger } from '../src/ports.ts';
import { harness } from './harness.ts';

const log: Logger = { info() {}, warn() {}, error() {} };
const T = new Date('2026-10-05T02:00:00Z');

function probe(
  check: HealthCheck | undefined,
  over: { engineOff?: boolean; now?: () => Date; ttlMs?: number } = {},
) {
  return engineHealthProbe({
    health: check ? [{ name: 'database', check: async () => {} }, check] : [],
    engineOff: over.engineOff ?? false,
    log,
    now: over.now ?? (() => T),
    ...(over.ttlMs !== undefined ? { ttlMs: over.ttlMs } : {}),
  });
}

describe('engineHealthProbe', () => {
  it('探得到在线的工人：on', async () => {
    expect(await probe({ name: 'engine', check: async () => {} })()).toEqual({ state: 'on' });
  });

  it('任务队列上没有在拉活的工人（engine_offline）：down，写明是工人没起来或卡住了', async () => {
    const r = await probe({
      name: 'engine',
      check: async () => {
        throw new PublicHealthError('engine_offline', '引擎不在线', 'workflow 任务队列上没有 poller');
      },
    })();
    expect(r.state).toBe('down');
    expect(r.detail).toContain('没有在拉活的引擎工人');
  });

  it('连不上调度服务、探针超时、别的怪错误：全是 down，不当正常（这就是 D7：/healthz 里 temporal、engine 都 unreachable 时主页不许写正常）', async () => {
    for (const err of [
      new PublicHealthError('not_connected', 'Temporal 客户端还没接上'),
      new PublicHealthError('timeout', '3 秒没回应'),
      new Error('ECONNREFUSED 10.0.0.1:7233'),
    ]) {
      const r = await probe({
        name: 'engine',
        check: async () => {
          throw err;
        },
      })();
      expect(r.state).toBe('down');
      expect(r.detail).toContain('连不上调度服务');
      // 内部地址、错误原文不进主页
      expect(JSON.stringify(r)).not.toContain('10.0.0.1');
    }
  });

  it('这台后端没有引擎探针（内存版、开发）：unknown，不是 on', async () => {
    const r = await probe(undefined)();
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('没查成');
  });

  it('按设置没开引擎：off（已停用），不去探；engine 项自己报「未接」也算 off', async () => {
    let probed = 0;
    const check: HealthCheck = {
      name: 'engine',
      check: async () => {
        probed += 1;
        throw new Error('不该被探');
      },
    };
    expect(await probe(check, { engineOff: true })()).toEqual({ state: 'off', detail: ENGINE_OFF_DETAIL });
    expect(await probe({ ...check, notWired: '这台机器按设置没开引擎' })()).toMatchObject({ state: 'off' });
    expect(probed).toBe(0);
  });

  it('结果留一小会儿：窗口内不重复去问 Temporal，过了窗口重新探（引擎起来、挂掉都能跟上）', async () => {
    let calls = 0;
    let up = false;
    let t = T.getTime();
    const p = probe(
      {
        name: 'engine',
        check: async () => {
          calls += 1;
          if (!up) throw new PublicHealthError('engine_offline', '引擎不在线');
        },
      },
      { now: () => new Date(t), ttlMs: 10_000 },
    );
    expect((await p()).state).toBe('down');
    t += 5_000;
    up = true;
    expect((await p()).state).toBe('down'); // 还在窗口内，不重探
    expect(calls).toBe(1);
    t += 6_000;
    expect((await p()).state).toBe('on');
    expect(calls).toBe(2);
  });
});

describe('/api/home 的引擎那一格（接到真路由上）', () => {
  const HOME = WEB_API_PREFIX + WebRoutes.home.path;
  async function engineOf(h: ReturnType<typeof harness>) {
    const { cookie } = await h.login();
    const res = await h.cockpit.request(HOME, { headers: { cookie } });
    expect(res.status).toBe(200);
    return HomeResponseSchema.parse(await res.json()).health.engine;
  }

  it('引擎探针探得到：on；探不到：down——和 /healthz 的 engine 项是同一个探针', async () => {
    expect(await engineOf(harness({ health: [{ name: 'engine', check: async () => {} }] }))).toEqual({
      state: 'on',
    });
    const down = await engineOf(
      harness({
        health: [
          {
            name: 'engine',
            check: async () => {
              throw new PublicHealthError('engine_offline', '引擎不在线');
            },
          },
        ],
      }),
    );
    expect(down.state).toBe('down');
  });

  it('开发 / 内存版没有探针：unknown；按设置没开引擎：off', async () => {
    expect((await engineOf(harness())).state).toBe('unknown');
    expect((await engineOf(harness({ config: { engineOff: true } }))).state).toBe('off');
  });
});
