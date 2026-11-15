#!/usr/bin/env node
// 只读。对照 templates/magpie-expected.json。不写配置，不打印密钥。
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultExpected = join(here, '..', 'templates', 'magpie-expected.json');

const LOCKED = [
  ['webPort'],
  ['gatewayPort'],
  ['windows', 'binary'],
  ['windows', 'configDir'],
  ['linux', 'user'],
  ['linux', 'binary'],
  ['linux', 'envFile'],
  ['sync', 'address'],
  ['sync', 'encrypted'],
  ['sync', 'keys'],
  ['sync', 'signIns'],
  ['sync', 'delete'],
  ['sync', 'intervalMinutes'],
];

const SECRET_FIELD =
  /^(apiKey|token|secret|password|passphrase|authorization|cookie|email|accessToken|refreshToken)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SECRET_TEXT = /^(?:sk-|github_pat_|ghp_|Bearer )/;

function parseArgs(argv) {
  const out = { expected: defaultExpected, actual: null, config: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--expected') out.expected = need(argv, ++i, arg);
    else if (arg === '--actual') out.actual = need(argv, ++i, arg);
    else if (arg === '--config') out.config = need(argv, ++i, arg);
    else throw new Error(`不认识的参数 ${arg}`);
  }
  return out;
}

function need(argv, index, flag) {
  if (index >= argv.length) throw new Error(`${flag} 缺少值`);
  return argv[index];
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`读不到 ${path}（${error.code ?? 'error'}）`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`不是 JSON：${path}`);
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELD.test(key)) continue;
      out[key] = redact(item);
    }
    return out;
  }
  if (typeof value === 'string' && (EMAIL.test(value) || SECRET_TEXT.test(value))) return '[redacted]';
  return value;
}

function get(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return null;
    cur = cur[key];
  }
  return cur ?? null;
}

function defaultConfig() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : join(homedir(), '.config');
  return join(base, 'magpie');
}

function portsFromUnit() {
  const path = '/etc/systemd/system/magpie.service';
  if (!existsSync(path)) return { webPort: null, gatewayPort: null };
  const text = readFileSync(path, 'utf8');
  const gateway = text.match(/MAGPIE_ADDR=\S+:(\d+)/);
  const web = text.match(/--addr(?:\s+|=)\S+:(\d+)/);
  return {
    webPort: web ? Number(web[1]) : null,
    gatewayPort: gateway ? Number(gateway[1]) : null,
  };
}

function linuxProbe(expected) {
  if (platform() === 'win32') return { user: null, binary: null, envFile: null };
  let user = null;
  try {
    const line = readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find((row) => row.startsWith(`${expected.linux.user}:`));
    if (line) user = line.split(':')[0];
  } catch {
    user = null;
  }
  return {
    user,
    binary: existsSync(expected.linux.binary) ? expected.linux.binary : null,
    envFile: existsSync(expected.linux.envFile) ? expected.linux.envFile : null,
  };
}

function windowsProbe(expected) {
  if (platform() !== 'win32') return { binary: null, configDir: null };
  return {
    binary: existsSync(expected.windows.binary) ? expected.windows.binary : null,
    configDir: expected.windows.configDir,
  };
}

function loadState(configDir) {
  const path = join(configDir, 'bootstrap-state.json');
  if (!existsSync(path)) return null;
  return redact(readJson(path));
}

function projectProbe(expected, configDir) {
  const ports = portsFromUnit();
  const state = loadState(configDir);
  const sync = state && state.sync && typeof state.sync === 'object' ? state.sync : null;
  return {
    webPort: ports.webPort ?? state?.webPort ?? null,
    gatewayPort: ports.gatewayPort ?? state?.gatewayPort ?? null,
    windows: platform() === 'win32' ? windowsProbe(expected) : null,
    linux: platform() === 'win32' ? null : linuxProbe(expected),
    sync,
    fields: fieldsForProbe(),
  };
}

function fieldsForProbe() {
  const fields = [['webPort'], ['gatewayPort']];
  if (platform() === 'win32') fields.push(['windows', 'binary'], ['windows', 'configDir']);
  else fields.push(['linux', 'user'], ['linux', 'binary'], ['linux', 'envFile']);
  for (const key of ['address', 'encrypted', 'keys', 'signIns', 'delete', 'intervalMinutes']) {
    fields.push(['sync', key]);
  }
  return fields;
}

function diffLocked(expected, actual, fields) {
  const rows = [];
  for (const path of fields) {
    const want = get(expected, path);
    const got = get(actual, path);
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      rows.push({ path: path.join('.'), want, got });
    }
  }
  return rows;
}

function printDiff(rows) {
  console.log(`不一致 ${rows.length} 处`);
  for (const row of rows) {
    console.log(row.path);
    console.log(`  模板: ${JSON.stringify(row.want)}`);
    console.log(`  读到: ${JSON.stringify(row.got)}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: magpie-verify [--expected 文件] [--actual 文件] [--config 目录]');
    console.log('只读对照模板。不一致打印差异，退出码 1。');
    return 0;
  }
  const expected = redact(readJson(args.expected));
  if (args.actual) {
    const actual = redact(readJson(args.actual));
    const rows = diffLocked(expected, actual, LOCKED);
    if (rows.length) {
      printDiff(rows);
      return 1;
    }
    console.log('一致');
    return 0;
  }
  const configDir = args.config ?? defaultConfig();
  const probed = projectProbe(expected, configDir);
  const rows = diffLocked(expected, probed, probed.fields);
  if (rows.length) {
    printDiff(rows);
    return 1;
  }
  console.log('一致');
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : '核对失败');
  process.exit(2);
}
