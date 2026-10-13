// 不跑代码也能查的：往飞书发东西只有一个出口、样例里没有真凭据、
// 飞书收缩（#2047 F1）退役的东西不再有人提、#1022 删掉的旧接口不再有人调。
import { readdirSync, readFileSync } from 'node:fs';
import * as shared from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMING } from '../src/gateway.ts';

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
    // 能出现的只有：空、占位符 <…>、样例域名（真域名公开仓不写，见设计第十四节）。
    const allowed = (v: string) => v === '' || /<[^>]+>/.test(v) || v === 'https://cockpit.example.com';
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

  it('#1022 删掉的旧接口（旧推送、盘面、卡片登记、草稿、查进度、关注）网关源码里一条都不提，shared 里也没有它们的路由表', () => {
    const retired = /\/feishu\/(outbox|board|cards\/|drafts|follows|tasks|messages)|FeishuRoutes/;
    const mentioning = sources.filter((s) => retired.test(s.text)).map((s) => s.file);
    expect(mentioning).toEqual([]);
    expect((shared as Record<string, unknown>).FeishuRoutes).toBeUndefined();
  });

  it('飞书收缩（#2047 F1）：网关源码里没有收原话、撤回、补漏、意图卡、机器人菜单；也不碰意图库的接口', () => {
    const retired =
      /intakeMessage|intakeRecall|intakeCursors|intentCards|ackIntentCards|recordRejection|createIntentCards|toIntake|onMessage|onRecall|onMenu|menu_v6|recalled_v1|im\.message\.receive|\/feishu\/intake\/(messages|recalls|cursors|rejections)|\/feishu\/intent-cards/;
    const mentioning = sources.filter((s) => retired.test(s.text)).map((s) => s.file);
    expect(mentioning).toEqual([]);
    expect(sources.map((s) => s.file)).not.toContain('intake.ts');
    expect(sources.map((s) => s.file)).not.toContain('intent-cards.ts');
  });

  it('时间预算守得住：向后端报用量的间隔远小于后端 5 分钟没来就报红的时限', () => {
    expect(DEFAULT_TIMING.backendMs).toBe(5_000);
    expect(DEFAULT_TIMING.usageEveryMs).toBeLessThan(5 * 60_000);
  });

  it('样例配置：只订阅进群事件和卡片回调；不再要求收消息、撤回、菜单，也不再有收到表情', () => {
    const env = read(new URL('deploy/feishu.env.example', pkg));
    expect(env).toContain('im.chat.member.user.added_v1');
    expect(env).toContain('im:chat:readonly');
    expect(env).toContain('im:message:send_as_bot');
    expect(env).not.toContain('im:message.group_msg');
    expect(env).not.toMatch(/event_key/);
    expect(env).not.toMatch(/^FEISHU_ACK_EMOJI=/m);
  });
});
