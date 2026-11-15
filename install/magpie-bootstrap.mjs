#!/usr/bin/env node
// 幂等。只写配置目录里的 bootstrap-state.json（无密钥）。--dry-run 不碰在跑的配置。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultExpected = join(here, '..', 'templates', 'magpie-expected.json');
const stateName = 'bootstrap-state.json';

function parseArgs(argv) {
  const out = { expected: defaultExpected, config: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--expected') out.expected = need(argv, ++i, arg);
    else if (arg === '--config') out.config = need(argv, ++i, arg);
    else throw new Error(`不认识的参数 ${arg}`);
  }
  return out;
}

function need(argv, index, flag) {
  if (index >= argv.length) throw new Error(`${flag} 缺少值`);
  return argv[index];
}

function defaultConfig() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : join(homedir(), '.config');
  return join(base, 'magpie');
}

function contract(expected) {
  return {
    webPort: expected.webPort,
    gatewayPort: expected.gatewayPort,
    windows: {
      binary: expected.windows.binary,
      configDir: expected.windows.configDir,
    },
    linux: {
      user: expected.linux.user,
      binary: expected.linux.binary,
      envFile: expected.linux.envFile,
    },
    sync: {
      address: expected.sync.address,
      encrypted: expected.sync.encrypted,
      keys: expected.sync.keys,
      signIns: expected.sync.signIns,
      delete: expected.sync.delete,
      intervalMinutes: expected.sync.intervalMinutes,
    },
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: magpie-bootstrap [--dry-run] [--config 目录] [--expected 文件]');
    console.log('--dry-run 只打印，不创建目录，不改文件。');
    return 0;
  }
  const expected = JSON.parse(readFileSync(args.expected, 'utf8'));
  const body = serialize(contract(expected));
  const configDir = args.config ?? defaultConfig();
  const target = join(configDir, stateName);
  const exists = existsSync(target);
  let current = null;
  if (exists) current = readFileSync(target, 'utf8');
  const same = current === body;

  if (args.dryRun) {
    if (!existsSync(configDir)) console.log(`将创建目录 ${configDir}`);
    console.log(same ? `不变 ${target}` : `将写入 ${target}`);
    return 0;
  }

  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (same) {
    console.log(`不变 ${target}`);
    return 0;
  }
  writeFileSync(target, body, { mode: 0o600 });
  console.log(`已写入 ${target}`);
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : '准备失败');
  process.exit(2);
}
