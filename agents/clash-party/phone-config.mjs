// 手机（Clash Meta for Android）用的整份 mihomo 配置（#3993）。
//
//   pnpm clash-party phone-config [--profile <订阅名或 id>] [--url <订阅地址>] [--all] [--also <名,名>] [--google <名>] [--out <文件>] [--mihomo <mihomo 可执行文件>] [--data-dir <...>]
//
// 多订阅（可选）：默认只用 current 一个，和以前完全一样。--all 放进全部 remote 订阅，--also 指名再加几个，--google 指定谁是 Google 订阅（默认 current）。
// 每个订阅一个 provider（名字＝订阅名）；Google 美国组只引用 Google 订阅（节点名不改），节点选择引用全部；非 Google 订阅的节点名加「订阅名 | 」前缀，
// 免得不同订阅的同名节点在节点选择里分不清。单订阅不加前缀、provider 仍叫「订阅」。
//
// 为什么要整份：手机上的 App 没有 Clash Party 那种规则覆写，只能导入一份完整配置。订阅用 proxy-providers 引用，节点由手机自己按间隔更新，
// 文件导入一次就不用再换。Google 相关的组和规则不在这里另写一份，直接读 agy-google-us.yaml（只维护那一份）。
// 订阅地址默认取 Clash Party 的 profile.yaml 里 current 指的那个；输出默认写到仓里 gitignored 的 _tmp/clash-phone.yaml，里面有订阅地址，不能进仓。
// 生成后用 mihomo -t 只校验不启动（给了 --mihomo、环境变量 MIHOMO_BIN 或 PATH 上有 mihomo 才做；找不到会明说「没校验」，不当成通过）。
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PHONE_OUT = join(HERE, '..', '..', '_tmp', 'clash-phone.yaml');
export const PROVIDER = '订阅';
export const MAIN_GROUP = '节点选择';
const PRIVATE_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
];

/**
 * 从 Clash Party 的 profile.yaml 挑订阅：默认 current，--profile 可给 id 或名字。
 * @param {string} profileYamlText
 * @param {string} [pick]
 * @returns {{ id: string, name: string, url: string }}
 */
export function pickSubscription(profileYamlText, pick) {
  const doc = parse(profileYamlText) ?? {};
  /** @type {{ id: string, name: string, type?: string, url?: string }[]} */
  const items = doc.items ?? [];
  const want = pick ?? doc.current;
  const item = items.find((i) => i.id === want || i.name === want);
  if (!item)
    throw new Error(`profile.yaml 里找不到订阅 ${want ?? '(没有 current)'}，用 --profile 或 --url 指定`);
  if (!item.url) throw new Error(`订阅「${item.name}」不是远程订阅（没有地址），用 --url 指定`);
  return { id: item.id, name: item.name, url: item.url };
}

/**
 * 多订阅：第一个是 Google 订阅（默认 current，--google 可改），其后是 --all 的全部 remote 订阅或 --also 指名的，去重。
 * @param {string} profileYamlText
 * @param {{ profile?: string | undefined, all?: boolean | undefined, also?: string[] | undefined, google?: string | undefined }} [o]
 * @returns {{ subs: { id: string, name: string, url: string }[], googleName: string }}
 */
export function pickSubscriptions(profileYamlText, { profile, all, also = [], google } = {}) {
  const doc = parse(profileYamlText) ?? {};
  /** @type {{ id: string, name: string, type?: string, url?: string }[]} */
  const items = doc.items ?? [];
  const main = pickSubscription(profileYamlText, google ?? profile);
  /** @type {{ id: string, name: string, url: string }[]} */
  const subs = [main];
  const add = (/** @type {{ id: string, name: string, url: string }} */ s) => {
    if (!subs.some((x) => x.id === s.id)) subs.push(s);
  };
  if (profile && google) add(pickSubscription(profileYamlText, profile));
  if (all) for (const i of items) if (i.url) add({ id: i.id, name: i.name, url: i.url });
  for (const n of also) add(pickSubscription(profileYamlText, n));
  const names = subs.map((s) => s.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`有两个订阅都叫「${dup}」，provider 名会冲突，先在 Clash Party 里改名`);
  return { subs, googleName: main.name };
}

/** 把文字里的 http(s) 地址打码，只留域名，免得订阅地址（含 token）进日志。 */
export function maskUrls(/** @type {string} */ text) {
  return text.replace(/https?:\/\/([^\s/"']+)[^\s"']*/g, 'https://$1/***');
}

/**
 * @param {{ url?: string, subs?: { name: string, url: string }[], googleName?: string, override: Record<string, any> }} opts override 是 agy-google-us.yaml 解析后的对象
 * @returns {Record<string, any>}
 */
export function buildPhoneConfig({ url, subs: multi, googleName, override }) {
  // 单订阅（含 --url）：provider 叫「订阅」，不加前缀；多订阅：provider 用订阅名。
  const single = !multi || multi.length <= 1;
  /** @type {{ name: string, url: string }[]} */
  const subs = single ? [{ name: PROVIDER, url: url ?? multi?.[0]?.url ?? '' }] : multi;
  const googleProvider = single ? PROVIDER : (googleName ?? subs[0]?.name);
  if (!subs.some((s) => s.name === googleProvider))
    throw new Error(`Google 订阅「${googleProvider}」不在订阅列表里`);
  const providers = subs.map((s) => s.name);
  /** @type {Record<string, any>[]} */
  const srcGroups = override['+proxy-groups'] ?? [];
  const google = srcGroups[0];
  if (!google) throw new Error('覆写里没有 Google 组');
  const { 'include-all-proxies': _all, ...rest } = google;
  /** @type {string[]} */
  const googleRules = (override['+rules'] ?? []).filter(
    (/** @type {string} */ r) => !r.startsWith('PROCESS-NAME,'),
  );
  return {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    ipv6: false,
    'unified-delay': true,
    'tcp-concurrent': true,
    'geodata-mode': false,
    'geo-auto-update': true,
    'geo-update-interval': 168,
    'geox-url': {
      geoip: 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
      geosite: 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
      mmdb: 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb',
    },
    profile: { 'store-selected': true, 'store-fake-ip': true },
    dns: {
      enable: true,
      ipv6: false,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'respect-rules': false,
      'default-nameserver': ['223.5.5.5', '119.29.29.29'],
      nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
      'proxy-server-nameserver': ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
      'fake-ip-filter': ['*.lan', '*.local', '+.msftconnecttest.com', '+.msftncsi.com'],
    },
    'proxy-providers': Object.fromEntries(
      subs.map((s, i) => [
        s.name,
        {
          type: 'http',
          url: s.url,
          path: single ? './providers/subscription.yaml' : `./providers/subscription-${i + 1}.yaml`,
          interval: 3600,
          header: { 'User-Agent': ['clash.meta'] },
          'health-check': {
            enable: true,
            url: 'https://www.gstatic.com/generate_204',
            interval: 600,
            lazy: true,
          },
          // 非 Google 订阅加前缀；Google 订阅节点名不动（手机上认「US - 洛杉矶 - 13」这类名字）。
          ...(single || s.name === googleProvider
            ? {}
            : { override: { 'additional-prefix': `${s.name} | ` } }),
        },
      ]),
    ),
    // Google 美国放第一个；组本身（名字、filter）取自覆写文件，这里只把「全部节点」换成引用订阅。
    'proxy-groups': [
      { ...rest, use: [googleProvider] },
      // 默认落在 Google 美国（和 agy 同一出口），DIRECT 只做手动备选；直接写 DIRECT 在 mihomo 里会默认直连，外网全走直连。
      { name: MAIN_GROUP, type: 'select', use: providers, proxies: [google.name, 'DIRECT'] },
    ],
    rules: [
      ...googleRules,
      `GEOSITE,category-ai-!cn,${google.name}`,
      ...PRIVATE_CIDRS.map((c) => `IP-CIDR,${c},DIRECT,no-resolve`),
      'GEOSITE,cn,DIRECT',
      'GEOIP,CN,DIRECT',
      `MATCH,${MAIN_GROUP}`,
    ],
  };
}

/**
 * mihomo -t：geo 文件拷到临时目录，免得校验时去下载或碰到别的数据目录。
 * @param {string} mihomo
 * @param {string} cfgPath
 * @param {string} [geoDir] 有 geoip/geosite/country.mmdb 的目录（Clash Party 的 work 目录）
 */
export function validateWithMihomo(mihomo, cfgPath, geoDir) {
  const home = mkdtempSync(join(tmpdir(), 'mihomo-t-'));
  try {
    if (geoDir)
      for (const f of ['geoip.dat', 'geosite.dat', 'geoip.metadb', 'country.mmdb', 'ASN.mmdb'])
        if (existsSync(join(geoDir, f))) copyFileSync(join(geoDir, f), join(home, f));
    const r = spawnSync(mihomo, ['-d', home, '-t', '-f', resolve(cfgPath)], {
      encoding: 'utf8',
      timeout: 60000,
    });
    // ok 为 null＝没跑成（找不到可执行文件等），不等于通过。
    if (r.error) return { ok: null, output: r.error.message };
    return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * @param {{ dataDir: string, overrideSrc: string, profile?: string | undefined, url?: string | undefined, all?: boolean | undefined, also?: string[] | undefined, google?: string | undefined, out?: string | undefined, mihomo?: string | undefined }} o
 */
export function phoneConfig({
  dataDir,
  overrideSrc,
  profile,
  url,
  all,
  also,
  google,
  out = PHONE_OUT,
  mihomo,
}) {
  const override = parse(readFileSync(overrideSrc, 'utf8'));
  /** @type {Record<string, any>} */
  let cfg;
  /** @type {string[]} */
  let subNames;
  if (url) {
    subNames = ['(--url)'];
    cfg = buildPhoneConfig({ url, override });
  } else {
    const p = join(dataDir, 'profile.yaml');
    if (!existsSync(p)) throw new Error(`没找到 ${p}（没装 Clash Party？用 --url 指定订阅地址）`);
    const { subs, googleName } = pickSubscriptions(readFileSync(p, 'utf8'), { profile, all, also, google });
    subNames = subs.map((s) => (s.name === googleName && subs.length > 1 ? `${s.name}（Google）` : s.name));
    cfg = buildPhoneConfig({ subs, googleName, override });
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, stringify(cfg), 'utf8');
  const bin = mihomo ?? process.env.MIHOMO_BIN ?? 'mihomo';
  const check = validateWithMihomo(bin, out, join(dataDir, 'work'));
  return { out, subName: subNames.join('、'), checked: { ...check, output: maskUrls(check.output) } };
}
