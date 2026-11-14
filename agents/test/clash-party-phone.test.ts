// 手机配置（#3993）：订阅取自 Clash Party 的 current，Google 组和规则读覆写文件那一份，订阅用 provider 引用。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GROUP_NAME, OVERRIDE_SRC } from '../clash-party/install.mjs';
import {
  buildPhoneConfig,
  MAIN_GROUP,
  maskUrls,
  PROVIDER,
  pickSubscription,
  pickSubscriptions,
} from '../clash-party/phone-config.mjs';

const override = parse(readFileSync(OVERRIDE_SRC, 'utf8'));
const profiles = [
  'current: b',
  'items:',
  '  - { id: a, name: 甲, type: remote, url: "https://a.example/sub" }',
  '  - { id: b, name: 乙, type: remote, url: "https://b.example/sub" }',
  '  - { id: c, name: 丙, type: local }',
].join('\n');

describe('pickSubscription', () => {
  it('默认取 current，也能按 id 或名字挑', () => {
    expect(pickSubscription(profiles).url).toBe('https://b.example/sub');
    expect(pickSubscription(profiles, 'a').name).toBe('甲');
    expect(pickSubscription(profiles, '乙').id).toBe('b');
  });
  it('找不到、不是远程订阅都报错', () => {
    expect(() => pickSubscription(profiles, 'zzz')).toThrow(/找不到订阅/);
    expect(() => pickSubscription(profiles, 'c')).toThrow(/不是远程订阅/);
  });
});

describe('buildPhoneConfig', () => {
  const cfg = buildPhoneConfig({ url: 'https://x.example/sub', override });
  it('订阅用 provider 引用，带更新间隔和健康检查', () => {
    expect(cfg['proxy-providers'][PROVIDER]).toMatchObject({
      type: 'http',
      url: 'https://x.example/sub',
      interval: 3600,
      'health-check': { enable: true },
    });
    expect(cfg.proxies).toBeUndefined();
  });
  it('Google 美国排第一、select、filter 和覆写同一份，节点选择第二', () => {
    const [g, main] = cfg['proxy-groups'];
    expect(g).toMatchObject({ name: GROUP_NAME, type: 'select', use: [PROVIDER] });
    expect(g.filter).toBe(override['+proxy-groups'][0].filter);
    expect(g['include-all-proxies']).toBeUndefined();
    expect(main).toMatchObject({ name: MAIN_GROUP, type: 'select', use: [PROVIDER] });
    // mihomo 默认选中 proxies 的第一个候选，第一个必须是代理组而不是 DIRECT，否则外网流量默认直连。
    expect(main.proxies[0]).toBe(GROUP_NAME);
    expect(main.proxies).toContain('DIRECT');
  });
  it('规则：覆写里的 Google 规则（去掉进程名）、AI、私网和国内直连、最后走节点选择', () => {
    const rules: string[] = cfg.rules;
    const google = override['+rules'].filter((r: string) => !r.startsWith('PROCESS-NAME,'));
    expect(rules.slice(0, google.length)).toEqual(google);
    expect(rules.some((r) => r.startsWith('PROCESS-NAME'))).toBe(false);
    expect(rules).toContain(`GEOSITE,category-ai-!cn,${GROUP_NAME}`);
    expect(rules.slice(-3)).toEqual(['GEOSITE,cn,DIRECT', 'GEOIP,CN,DIRECT', `MATCH,${MAIN_GROUP}`]);
    expect(rules.indexOf('IP-CIDR,192.168.0.0/16,DIRECT,no-resolve')).toBeGreaterThan(google.length);
  });
  it('单订阅：provider 叫「订阅」、不加前缀', () => {
    expect(Object.keys(cfg['proxy-providers'])).toEqual([PROVIDER]);
    expect(cfg['proxy-providers'][PROVIDER].override).toBeUndefined();
  });
});

describe('多订阅', () => {
  it('pickSubscriptions：默认只有 current；--all 全部 remote，current 在前；--also 指名；--google 换 Google 订阅', () => {
    expect(pickSubscriptions(profiles).subs.map((s) => s.name)).toEqual(['乙']);
    const all = pickSubscriptions(profiles, { all: true });
    expect(all.subs.map((s) => s.name)).toEqual(['乙', '甲']);
    expect(all.googleName).toBe('乙');
    expect(pickSubscriptions(profiles, { also: ['甲'] }).subs).toHaveLength(2);
    const g = pickSubscriptions(profiles, { all: true, google: '甲' });
    expect(g.googleName).toBe('甲');
    expect(g.subs.map((s) => s.name)).toEqual(['甲', '乙']);
  });
  it('maskUrls 只留域名', () => {
    expect(maskUrls('get https://a.example/sub?token=abc ok')).toBe('get https://a.example/*** ok');
  });
  const subs = [
    { name: '甲', url: 'https://a.example/sub' },
    { name: '乙', url: 'https://b.example/sub' },
  ];
  const cfg = buildPhoneConfig({ subs, googleName: '甲', override });
  it('每个订阅一个 provider，路径不重名；只有非 Google 订阅加前缀', () => {
    const p = cfg['proxy-providers'];
    expect(Object.keys(p)).toEqual(['甲', '乙']);
    expect(p.甲.override).toBeUndefined();
    expect(p.乙.override).toEqual({ 'additional-prefix': '乙 | ' });
    expect(p.甲.path).not.toBe(p.乙.path);
    expect(p.乙).toMatchObject({ interval: 3600, 'health-check': { enable: true } });
  });
  it('Google 美国只引用 Google provider；节点选择引用全部，Google 美国在前、DIRECT 在后', () => {
    const [g, main] = cfg['proxy-groups'];
    expect(g).toMatchObject({ name: GROUP_NAME, use: ['甲'] });
    expect(g.filter).toBe(override['+proxy-groups'][0].filter);
    expect(main.use).toEqual(['甲', '乙']);
    expect(main.proxies).toEqual([GROUP_NAME, 'DIRECT']);
  });
  it('Google 订阅不在列表里就报错', () => {
    expect(() => buildPhoneConfig({ subs, googleName: '丙', override })).toThrow(/不在订阅列表/);
  });
});
