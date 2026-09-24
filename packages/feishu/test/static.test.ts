// 不跑代码也能查的：往飞书发东西只有一个出口、推送只走推送出口、样例里没有真凭据、
// 跟别的包约好的名字（请求头、驾驶舱页面）还对得上、时间预算加起来守得住设计目标。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as shared from '@fleet-dao/shared';
import { FEISHU_GATEWAY_WEB_ROUTES, FEISHU_UNDERSTAND_MS, FeishuRoutes, WebRoutes } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { ACTING_HEADER } from '../src/backend.ts';
import { COCKPIT_PATHS } from '../src/cards.ts';
import { DEFAULT_TIMING, MENU_KEYS, TARGET_CARD_MS } from '../src/gateway.ts';

const pkg = new URL('../', import.meta.url);
const srcDir = new URL('src/', pkg);
const read = (url: URL) => readFileSync(url, 'utf8');
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: read(new URL(f, srcDir)) }));

describe('静态检查', () => {
  it('往飞书发东西只有一个出口：只有 lark.ts 碰飞书 SDK', () => {
    const touching = sources
      .filter((s) => /@larksuiteoapi\/node-sdk|rawClient|\.im\.v1\./.test(s.text))
      .map((s) => s.file);
    expect(touching).toEqual(['lark.ts']);
  });

  it('三类推送 + 关注 + 追问只走推送出口（outbox.ts）：别处不画推送卡、不发超预算提醒', () => {
    const drawing = sources
      .filter((s) => /\boutboxCard\(|\bbudgetAlertCard\(/.test(s.text))
      .map((s) => s.file)
      .sort();
    expect(drawing).toEqual(['cards.ts', 'outbox.ts']);
  });

  it('只有 backend.ts 直接发 HTTP 请求（调后端都带通行证、都按约定校验返回）', () => {
    const fetching = sources.filter((s) => /\bfetch\(/.test(s.text)).map((s) => s.file);
    expect(fetching).toEqual(['backend.ts']);
  });

  it('样例配置只有占位符：没有真的应用凭据、群编号、open_id、通行证', () => {
    const env = read(new URL('deploy/feishu.env.example', pkg));
    const assignments = env
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split('=', 2) as [string, string]);
    expect(assignments.length).toBeGreaterThan(5);
    // 能出现的只有：空、占位符 <…>、数字默认值、默认表情、公开的驾驶舱域名（设计文档里就有）。
    const allowed = (v: string) =>
      v === '' ||
      /<[^>]+>/.test(v) ||
      /^[0-9]+$/.test(v) ||
      v === 'Get' ||
      v === 'https://fleetdao.dpdns.org';
    for (const [key, value] of assignments) {
      expect({ key, value, ok: allowed(value) }).toEqual({ key, value, ok: true });
    }
    const unit = read(new URL('deploy/fleet-feishu.service', pkg));
    expect(unit).toContain('User=fleet');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('EnvironmentFile=/etc/fleet-dao/feishu.env');
    expect(`${env}\n${unit}`).not.toMatch(/\b(cli|ou|oc|on)_[0-9a-f]{16,}\b/);
  });

  it('测试夹具是占位编号，不是真的', () => {
    const dir = new URL('test/fixtures/', pkg);
    for (const f of readdirSync(dir)) {
      expect({ f, leaked: /\b(cli|ou|oc|on|om)_[0-9a-f]{16,}\b/.test(read(new URL(f, dir))) }).toEqual({
        f,
        leaked: false,
      });
    }
  });

  const backendSide = (shared as Record<string, unknown>).FEISHU_ACTING_HEADER;
  it.skipIf(backendSide === undefined)(
    '「代表哪位创始人」的请求头和后端的一致（后端的常量 FEISHU_ACTING_HEADER 在 PR #9 里加，合进 main 之前跳过）',
    () => {
      expect(backendSide).toBe(ACTING_HEADER);
    },
  );

  it('网关要用的驾驶舱接口都在路由表里', () => {
    for (const name of FEISHU_GATEWAY_WEB_ROUTES) expect(WebRoutes[name]).toBeDefined();
  });

  it('每条飞书接口都标清了 acting：只有网关自己的后台活（盘面、待推送、回执、登记卡片）不带代表人', () => {
    const table = Object.entries(FeishuRoutes).map(([name, r]) => [name, r.acting] as const);
    expect(table.every(([, acting]) => acting === 'required' || acting === 'none')).toBe(true);
    expect(
      table
        .filter(([, acting]) => acting === 'none')
        .map(([name]) => name)
        .sort(),
    ).toEqual(['ackOutbox', 'board', 'outbox', 'putCard']);
    expect(table).toHaveLength(9);
  });

  const webRoutes = new URL('../../web/src/routes.ts', pkg);
  it.skipIf(!existsSync(webRoutes))('卡片直达的驾驶舱页面在前端的路由表里（前端合进来之前跳过）', () => {
    const routes = read(webRoutes);
    expect(routes).toContain(`route('${COCKPIT_PATHS.overview.slice(1)}'`);
    expect(routes).toContain(`route('${COCKPIT_PATHS.notifications.slice(1)}'`);
    expect(routes).toContain("route('tasks/:taskId'");
  });

  it('时间预算守得住：后端答应的理解时限 + 网关多等的 + 发卡的余量 < 确认卡 10 秒', () => {
    expect(DEFAULT_TIMING.understandWaitMs).toBeGreaterThan(FEISHU_UNDERSTAND_MS);
    // 等不到就发「正在理解」卡：一次回复消息给 1 秒余量（香港调飞书实测 0.17 秒）。
    expect(DEFAULT_TIMING.understandWaitMs + 1_000).toBeLessThanOrEqual(TARGET_CARD_MS);
  });

  it('菜单的 event_key 写进了样例配置的说明里（开发者后台照着配）', () => {
    const env = read(new URL('deploy/feishu.env.example', pkg));
    for (const key of Object.values(MENU_KEYS)) expect(env).toContain(key);
  });
});
