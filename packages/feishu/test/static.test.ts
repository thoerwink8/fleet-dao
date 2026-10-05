// 不跑代码也能查的：往飞书发东西只有一个出口、样例里没有真凭据、
// 跟别的包约好的名字（请求头）还对得上、时间预算加起来守得住设计目标、#1022 删掉的旧接口不再有人调。
import { readdirSync, readFileSync } from 'node:fs';
import * as shared from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { ACTING_HEADER } from '../src/backend.ts';
import { DEFAULT_TIMING, TARGET_ACK_MS } from '../src/gateway.ts';

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

  it('网关自己的报警（调不通后端）只在看守（watch.ts）里画、发', () => {
    const drawing = sources
      .filter((s) => /\blinkAlertCard\(/.test(s.text))
      .map((s) => s.file)
      .sort();
    expect(drawing).toEqual(['cards.ts', 'watch.ts']);
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
    // 能出现的只有：空、占位符 <…>、数字默认值、默认表情、样例域名（真域名公开仓不写，见设计第十四节）。
    const allowed = (v: string) =>
      v === '' ||
      /<[^>]+>/.test(v) ||
      /^[0-9]+$/.test(v) ||
      v === 'Get' ||
      v === 'https://cockpit.example.com';
    for (const [key, value] of assignments) {
      expect({ key, value, ok: allowed(value) }).toEqual({ key, value, ok: true });
    }
    // 香港真正装的单元在仓根 deploy/hk/（deploy/hk.sh 装；包里不再另放一份样例）
    const unit = read(new URL('../../deploy/hk/fleet-feishu.service', pkg));
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

  it('#1022 删掉的旧接口（旧推送、盘面、卡片登记、草稿、查进度、关注）网关源码里一条都不提，shared 里也没有它们的路由表', () => {
    const retired = /\/feishu\/(outbox|board|cards\/|drafts|follows|tasks|messages)|FeishuRoutes/;
    const mentioning = sources.filter((s) => retired.test(s.text)).map((s) => s.file);
    expect(mentioning).toEqual([]);
    expect((shared as Record<string, unknown>).FeishuRoutes).toBeUndefined();
  });

  it('时间预算守得住：转后端 5 秒（方案 5.4）之内回来，「收到」2 秒内加上', () => {
    // 收原话给后端 5 秒（方案 5.4）；超时按没存成办（打「没记成」、记补漏），不再有「先回一张卡守住 10 秒」这套。
    expect(DEFAULT_TIMING.intakeMs).toBe(5_000);
    // 「收到」还是 2 秒的目标（design 15.4）：转后端比它慢没关系，表情是另外一步。
    expect(DEFAULT_TIMING.intakeMs).toBeGreaterThanOrEqual(TARGET_ACK_MS);
  });

  it('旧的菜单 event_key 已经从样例配置里删掉（菜单停用了，开发者后台也该删）', () => {
    const env = read(new URL('deploy/feishu.env.example', pkg));
    expect(env).toContain('im.message.recalled_v1');
    expect(env).toContain('im:message.group_msg');
    expect(env).toContain('im:message:readonly');
    // 不再要求配菜单：菜单停用了
    expect(env).toContain('菜单和卡片按钮都已停用');
    expect(env).not.toMatch(/event_key/);
  });
});
