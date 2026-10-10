#!/usr/bin/env node
// 恢复指挥官/box → 法国的 SSH 别名（#1732/#1773）：写 ~/.ssh/config 里的 Host，并写 ~/.fleet-dao/france-ssh。
// 用法：node ensure-france-ssh.mjs [--check]
// - fleet-fr-wg：经香港 myserver ProxyJump 到 10.99.0.2，IdentityFile ~/.ssh/fleet_login（root）
// - fleet-fr-carpool：直连法国公网主机（FLEET_FRANCE_HOST），User fleet-agent-carpool（本机桌面钥匙已在 authorized_keys）
// 缺私钥、缺 HostName 只报状态，不编造钥匙、不写公网 IP 进仓。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HOME || homedir();
const SSH_DIR = join(HOME, '.ssh');
const SSH_CONFIG = join(SSH_DIR, 'config');
const FRANCE_SSH = join(HOME, '.fleet-dao', 'france-ssh');
const LOGIN_KEY = join(SSH_DIR, 'fleet_login');
const CHECK = process.argv.includes('--check');

const WG_BEGIN = '# BEGIN fleet-dao fleet-fr-wg (#1732)';
const WG_END = '# END fleet-dao fleet-fr-wg (#1732)';
const CARPOOL_BEGIN = '# BEGIN fleet-dao fleet-fr-carpool (#1773)';
const CARPOOL_END = '# END fleet-dao fleet-fr-carpool (#1773)';

const wgBlock = () =>
  [
    WG_BEGIN,
    '# 指挥官 / box 经香港跳板连法国 WireGuard（#1732）。',
    '# 前提：本机已有 Host myserver（香港），且 ~/.ssh/fleet_login 私钥在、公钥在法国 root 的 authorized_keys。',
    '# 由 ensure-france-ssh.mjs 装进 ~/.ssh/config；已有同名 Host 不覆盖。',
    'Host fleet-fr-wg',
    '  HostName 10.99.0.2',
    '  User root',
    '  ProxyJump myserver',
    '  IdentityFile ~/.ssh/fleet_login',
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    WG_END,
    '',
  ].join('\n');

/**
 * @param {string} hostName
 * @param {boolean} withLogin
 */
const carpoolBlock = (hostName, withLogin) =>
  [
    CARPOOL_BEGIN,
    '# 直连法国 → 会话用户 fleet-agent-carpool（#1773）：不依赖 WG；可当 local-exec 离线时的恢复路。',
    '# HostName 来自环境变量 FLEET_FRANCE_HOST（公网 IP 或 Contabo 短名，不进仓）。',
    '# 本机桌面钥匙须已在法国 carpool 的 authorized_keys；若有 ~/.ssh/fleet_login 也写上（本机环回自测用）。',
    'Host fleet-fr-carpool',
    `  HostName ${hostName}`,
    '  User fleet-agent-carpool',
    ...(withLogin ? ['  IdentityFile ~/.ssh/fleet_login'] : []),
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    CARPOOL_END,
    '',
  ].join('\n');

/**
 * @param {string} text
 * @param {string} begin
 * @param {string} end
 * @param {string} block
 */
function upsertBlock(text, begin, end, block) {
  const start = text.indexOf(begin);
  if (start < 0) return { text: `${text.trimEnd()}\n\n${block}`, changed: true };
  const stop = text.indexOf(end, start);
  if (stop < 0) return { text: `${text.trimEnd()}\n\n${block}`, changed: true };
  const next = text.slice(0, start) + block + text.slice(stop + end.length).replace(/^\n/, '');
  return { text: next, changed: next !== text };
}

function main() {
  /** @type {string[]} */
  const notes = [];
  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME, '.fleet-dao'), { recursive: true, mode: 0o755 });

  let config = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, 'utf8') : '';
  let changed = false;

  if (!/^Host\s+fleet-fr-wg\s*$/m.test(config) || !config.includes(WG_BEGIN)) {
    const u = upsertBlock(config, WG_BEGIN, WG_END, wgBlock());
    config = u.text;
    changed = changed || u.changed;
    notes.push(u.changed ? '已写入 Host fleet-fr-wg' : 'Host fleet-fr-wg 已在');
  } else {
    notes.push('Host fleet-fr-wg 已在');
  }

  const hasLogin = existsSync(LOGIN_KEY);
  notes.push(hasLogin ? '私钥 ~/.ssh/fleet_login 在' : '缺私钥 ~/.ssh/fleet_login（WG 跳板 root 路不通）');

  const franceHost = (process.env.FLEET_FRANCE_HOST || '').trim();
  if (franceHost) {
    const u = upsertBlock(config, CARPOOL_BEGIN, CARPOOL_END, carpoolBlock(franceHost, hasLogin));
    config = u.text;
    changed = changed || u.changed;
    notes.push(u.changed ? `已写入 Host fleet-fr-carpool（${franceHost}）` : 'Host fleet-fr-carpool 已在');
  } else {
    notes.push('未设 FLEET_FRANCE_HOST：跳过 Host fleet-fr-carpool（桌面直连用）');
  }

  /** 优先：有 login 且走 WG；否则有公网主机用 carpool（桌面钥匙或 login）。 */
  let target = '';
  if (hasLogin && !franceHost) target = 'fleet-fr-wg';
  else if (franceHost) target = 'fleet-fr-carpool';
  else if (hasLogin) target = 'fleet-fr-wg';
  notes.push(
    target
      ? `france-ssh 指向 ${target}`
      : '还没有可用别名：请放 fleet_login，或设 FLEET_FRANCE_HOST 走 carpool',
  );

  if (CHECK) {
    for (const n of notes) console.log(n);
    process.exit(target ? 0 : 1);
  }

  if (changed) {
    writeFileSync(SSH_CONFIG, config.endsWith('\n') ? config : `${config}\n`, { mode: 0o600 });
    chmodSync(SSH_CONFIG, 0o600);
  }
  if (target) {
    writeFileSync(FRANCE_SSH, `${target}\n`, { mode: 0o600 });
    chmodSync(FRANCE_SSH, 0o600);
  }
  for (const n of notes) console.log(n);
  if (!target) process.exit(1);
}

main();
