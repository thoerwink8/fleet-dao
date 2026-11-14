// 手机配置（#3993）：订阅取自 Clash Party 的 current，Google 组和规则读覆写文件那一份，订阅用 provider 引用。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GROUP_NAME, OVERRIDE_SRC } from '../clash-party/install.mjs';
import { buildPhoneConfig, MAIN_GROUP, PROVIDER, pickSubscription } from '../clash-party/phone-config.mjs';

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
});
