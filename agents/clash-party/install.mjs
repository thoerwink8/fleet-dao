#!/usr/bin/env node
// Clash Party（mihomo-party）装上「agy 可用」的全局覆写，并切到规则模式（#3991）。
//
//   pnpm clash-party install [--data-dir <Clash Party 数据目录>] [--no-reload]
//   pnpm clash-party reload  [--data-dir <...>]     只把现有配置热加载进正在跑的内核
//
// install 做三件事（幂等，重跑不重复）：① 把 agy-google-us.yaml 拷到 <数据目录>/override/；② 在 override.yaml 里登记成
// global: true（其它覆写原样留着）；③ 把 mihomo.yaml 的 mode 设成 rule。然后如果内核在跑，自动 reload。
// reload 不重启 Clash Party：读 work/config.yaml（应用上次生成的配置），去掉上一次装的组和规则，套上本覆写、mode 设 rule，
// 写回 work/config.yaml（先留一份 .agy-bak），再经内核的控制管道（Windows 命名管道、macOS/Linux unix socket，无密钥）
// PUT /configs 热加载。
//
// 改这里之前必须知道：
// - 覆写合并语法照 Clash Party 的 deepMerge：数组键前缀 + 是前插、后缀 + 是后追加、其余整体替换。这里只实现覆写文件里用到的 + 前插。
// - Clash Party 把 override.yaml、mihomo.yaml 缓存在内存里：它在跑时，我们改的磁盘文件在它「下次启动」才被读；它若在那之前
//   自己写回（比如你在界面里改了覆写或切了模式），会把这里的改动盖掉。盖掉了重跑 install 即可（幂等）。要根治，装完退出再启动一次 Clash Party。
// - 数据目录不存在（没装 Clash Party）、yaml 读不出、内核在跑但热加载失败：明确报错、退出码 1，不报「装好了」。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument, stringify } from 'yaml';

export const OVERRIDE_ID = 'agy-google-us';
export const OVERRIDE_NAME = 'Antigravity 美国出口';
export const GROUP_NAME = 'Google 美国';
const HERE = dirname(fileURLToPath(import.meta.url));
export const OVERRIDE_SRC = join(HERE, 'agy-google-us.yaml');

export function defaultDataDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    if (!env.APPDATA) throw new Error('找不到 %APPDATA%，用 --data-dir 指定 Clash Party 数据目录');
    return join(env.APPDATA, 'mihomo-party');
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'mihomo-party');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mihomo-party');
}

// Clash Party 的 deepMerge 里数组键的部分：+key 前插，key+ 后追加，其余整体替换；对象递归。
/**
 * @param {Record<string, any>} target
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>}
 */
export function applyPatch(target, patch) {
  for (const key of Object.keys(patch)) {
    const val = patch[key];
    if (Array.isArray(val)) {
      if (key.startsWith('+')) {
        const k = key.slice(1);
        target[k] = [...val, ...(target[k] ?? [])];
      } else if (key.endsWith('+')) {
        const k = key.slice(0, -1);
        target[k] = [...(target[k] ?? []), ...val];
      } else target[key] = val;
    } else if (val && typeof val === 'object') {
      target[key] = applyPatch(target[key] && typeof target[key] === 'object' ? target[key] : {}, val);
    } else target[key] = val;
  }
  return target;
}

// 去掉上一次装的内容，再套一次，重复 reload 不叠规则。
/**
 * @param {Record<string, any>} config
 * @param {Record<string, any>} patch
 */
export function patchRuntimeConfig(config, patch) {
  /** @type {{ name: string }[]} */
  const groups = patch['+proxy-groups'] ?? [];
  const groupNames = new Set(groups.map((g) => g.name));
  /** @type {{ name: string }[]} */
  const have = config['proxy-groups'] ?? [];
  config['proxy-groups'] = have.filter((g) => !groupNames.has(g.name));
  const ours = new Set(patch['+rules'] ?? []);
  /** @type {string[]} */
  const rules = config.rules ?? [];
  config.rules = rules.filter((r) => !ours.has(r));
  applyPatch(config, patch);
  config.mode = 'rule';
  return config;
}

/** @param {string} dataDir */
export function installFiles(dataDir) {
  if (!existsSync(dataDir))
    throw new Error(`没找到 Clash Party 数据目录：${dataDir}（没装，或用 --data-dir 指定）`);
  const overrideDir = join(dataDir, 'override');
  mkdirSync(overrideDir, { recursive: true });
  copyFileSync(OVERRIDE_SRC, join(overrideDir, `${OVERRIDE_ID}.yaml`));

  const registryPath = join(dataDir, 'override.yaml');
  const registry = existsSync(registryPath)
    ? parseDocument(readFileSync(registryPath, 'utf8'))
    : parseDocument('items: []\n');
  if (registry.errors.length) throw new Error(`override.yaml 读不出：${registry.errors[0]?.message}`);
  if (!registry.get('items')) registry.set('items', []);
  /** @type {{ id: string }[]} */
  const list = registry.toJS().items ?? [];
  const entry = {
    id: OVERRIDE_ID,
    name: OVERRIDE_NAME,
    type: 'local',
    ext: 'yaml',
    global: true,
    updated: Date.now(),
  };
  const at = list.findIndex((i) => i.id === OVERRIDE_ID);
  if (at >= 0) registry.setIn(['items', at], registry.createNode(entry));
  else registry.addIn(['items'], registry.createNode(entry));
  writeFileSync(registryPath, String(registry), 'utf8');

  const mihomoPath = join(dataDir, 'mihomo.yaml');
  const mihomo = existsSync(mihomoPath)
    ? parseDocument(readFileSync(mihomoPath, 'utf8'))
    : parseDocument('mode: rule\n');
  if (mihomo.errors.length) throw new Error(`mihomo.yaml 读不出：${mihomo.errors[0]?.message}`);
  mihomo.set('mode', 'rule');
  writeFileSync(mihomoPath, String(mihomo), 'utf8');
}

/**
 * @param {string} [platform]
 * @param {number} [uid]
 */
export function findControllerSocket(platform = process.platform, uid = process.getuid?.()) {
  if (platform === 'win32') {
    const names = readdirSync('\\\\.\\pipe\\').filter((n) => n.startsWith('MihomoParty\\mihomo-'));
    return names.length ? `\\\\.\\pipe\\${names[names.length - 1]}` : undefined;
  }
  const socks = readdirSync('/tmp').filter(
    (n) => n.startsWith(`mihomo-party-${uid}-`) && n.endsWith('.sock'),
  );
  const last = socks.at(-1);
  return last ? join('/tmp', last) : undefined;
}

/**
 * @param {string} socketPath
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<{ status: number | undefined, text: string }>}
 */
function call(socketPath, method, path, body) {
  return new Promise((ok, fail) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let text = '';
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => ok({ status: res.statusCode, text }));
      },
    );
    req.on('error', fail);
    req.end(data);
  });
}

// 返回 'skipped'（内核没在跑）或 'reloaded'；热加载失败抛错。
/** @param {string} dataDir */
export async function reload(dataDir) {
  const sock = findControllerSocket();
  if (!sock) return 'skipped';
  const cfgPath = join(dataDir, 'work', 'config.yaml');
  if (!existsSync(cfgPath)) throw new Error(`内核在跑但没有 ${cfgPath}，没法热加载`);
  const text = readFileSync(cfgPath, 'utf8');
  const bak = `${cfgPath}.agy-bak`;
  if (!existsSync(bak)) writeFileSync(bak, text, 'utf8');
  const config = patchRuntimeConfig(parse(text), parse(readFileSync(OVERRIDE_SRC, 'utf8')));
  writeFileSync(cfgPath, stringify(config), 'utf8');
  const res = await call(sock, 'PUT', '/configs?force=true', { path: resolve(cfgPath) });
  if (res.status !== 204) throw new Error(`热加载失败：HTTP ${res.status} ${res.text}`);
  const now = JSON.parse((await call(sock, 'GET', '/configs')).text);
  if (now.mode !== 'rule') throw new Error(`热加载后模式是 ${now.mode}，不是 rule`);
  return 'reloaded';
}

/** @param {string[]} argv */
async function main(argv) {
  const [cmd = 'install', ...rest] = argv;
  const flag = (/** @type {string} */ n) => rest.includes(n);
  const di = rest.indexOf('--data-dir');
  const dataDir = di >= 0 ? rest[di + 1] : defaultDataDir();
  if (!dataDir || !['install', 'reload'].includes(cmd)) {
    console.error('用法：pnpm clash-party install|reload [--data-dir <目录>] [--no-reload]');
    return 1;
  }
  if (cmd === 'install') {
    installFiles(dataDir);
    console.log(
      `已写入 ${dataDir}：override/${OVERRIDE_ID}.yaml、override.yaml 登记 global、mihomo.yaml mode=rule`,
    );
  }
  if (cmd === 'reload' || !flag('--no-reload')) {
    const r = await reload(dataDir);
    console.log(
      r === 'reloaded'
        ? '已热加载进正在跑的内核（模式 rule）'
        : '内核没在跑：下次启动 Clash Party 时生效（装好后不用再做别的）',
    );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`失败：${err instanceof Error ? err.message : err}`);
      process.exit(1);
    },
  );
}
