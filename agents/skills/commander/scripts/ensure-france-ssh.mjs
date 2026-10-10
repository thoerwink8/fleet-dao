#!/usr/bin/env node
// 给本机 / box 装监督用的法国 SSH Host（#1732 fleet-fr-wg，#1773 fleet-fr-carpool，#1775 通路恢复）。
// 用法：
//   node ensure-france-ssh.mjs                  # 缺啥补啥：~/.ssh/config 两个 Host、~/.fleet-dao/france-ssh
//   node ensure-france-ssh.mjs --prefer carpool # france-ssh 写成 fleet-fr-carpool（默认 wg）
//   node ensure-france-ssh.mjs --check          # 只看不改
// 已有同名 Host 不覆盖。私钥 ~/.ssh/fleet_login 不替你造：没有只提醒。
// 法国那头：root 仍要认可 fleet_login（或桌面钥匙）；carpool 用户的 authorized_keys 要有对应公钥；
// fail2ban 须 ignoreip 含 10.99.0.0/24（见 deploy/france/fail2ban-sshd.jail），否则错钥匙三次会变成 Connection refused。

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WG_HOST = 'fleet-fr-wg';
export const CARPOOL_HOST = 'fleet-fr-carpool';
export const WG_MARKER_BEGIN = '# BEGIN fleet-dao fleet-fr-wg (#1732)';
export const WG_MARKER_END = '# END fleet-dao fleet-fr-wg (#1732)';
export const CARPOOL_MARKER_BEGIN = '# BEGIN fleet-dao fleet-fr-carpool (#1773)';
export const CARPOOL_MARKER_END = '# END fleet-dao fleet-fr-carpool (#1773)';

/**
 * @param {{ franceWgHost?: string, jumpHost?: string, carpoolHostName?: string, identityFile?: string }} [opts]
 */
export function wgBlock(opts = {}) {
  const hostName = opts.franceWgHost ?? '10.99.0.2';
  const jump = opts.jumpHost ?? 'myserver';
  const id = opts.identityFile ?? '~/.ssh/fleet_login';
  return `${WG_MARKER_BEGIN}
# 指挥官 / box 经香港跳板连法国 WireGuard（#1732）。
# 前提：本机已有 Host ${jump}（香港），且 ${id} 私钥在、公钥在法国 root 的 authorized_keys。
# 由 ensure-france-ssh.mjs 装进 ~/.ssh/config；已有同名 Host 不覆盖。
Host ${WG_HOST}
  HostName ${hostName}
  User root
  ProxyJump ${jump}
  IdentityFile ${id}
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
${WG_MARKER_END}
`;
}

/**
 * @param {{ francePublicHost?: string, identityFile?: string }} [opts]
 */
export function carpoolBlock(opts = {}) {
  const hostName = opts.francePublicHost ?? '10.99.0.2';
  const id = opts.identityFile ?? '~/.ssh/fleet_login';
  return `${CARPOOL_MARKER_BEGIN}
# 直连法国 → 会话用户 fleet-agent-carpool（#1773）：不依赖本机 WG；可当 local-exec 离线时的恢复路。
# HostName 默认隧道地址；公网直连把 FLEET_FRANCE_CARPOOL_HOST 设成法国公网 IP/域名再跑一遍。
# 本机桌面钥匙须已在法国 carpool 的 authorized_keys；若有 ${id} 也写上（本机环回自测用）。
Host ${CARPOOL_HOST}
  HostName ${hostName}
  User fleet-agent-carpool
  IdentityFile ${id}
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
${CARPOOL_MARKER_END}
`;
}

/** @param {string} text @param {string} host */
export function hasHost(text, host) {
  return new RegExp(`^Host\\s+${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text);
}

/**
 * @param {string} existing
 * @param {{ prefer?: 'wg' | 'carpool', franceWgHost?: string, francePublicHost?: string, jumpHost?: string, identityFile?: string }} [opts]
 * @returns {{ config: string, added: string[], skipped: string[] }}
 */
export function mergeSshConfig(existing, opts = {}) {
  const added = [];
  const skipped = [];
  let config = existing.replace(/\s*$/, '');
  const id = opts.identityFile ?? '~/.ssh/fleet_login';
  if (hasHost(config, WG_HOST)) skipped.push(WG_HOST);
  else {
    config = `${config}${config ? '\n\n' : ''}${wgBlock({ ...opts, identityFile: id }).trim()}`;
    added.push(WG_HOST);
  }
  if (hasHost(config, CARPOOL_HOST)) skipped.push(CARPOOL_HOST);
  else {
    config = `${config}${config ? '\n\n' : ''}${carpoolBlock({ ...opts, identityFile: id }).trim()}`;
    added.push(CARPOOL_HOST);
  }
  return { config: config ? `${config}\n` : '', added, skipped };
}

/**
 * @param {'wg' | 'carpool'} prefer
 * @returns {string}
 */
export function franceSshLine(prefer) {
  return `${prefer === 'carpool' ? CARPOOL_HOST : WG_HOST}\n`;
}

/**
 * @param {{
 *   home: string,
 *   prefer?: 'wg' | 'carpool',
 *   checkOnly?: boolean,
 *   env?: Record<string, string | undefined>,
 *   readText?: (path: string) => string,
 *   writeText?: (path: string, text: string, mode?: number) => void,
 *   exists?: (path: string) => boolean,
 *   mkdirp?: (path: string) => void,
 * }} io
 */
export function ensureFranceSsh(io) {
  const prefer = io.prefer ?? 'wg';
  const env = io.env ?? {};
  const readText = io.readText ?? ((p) => readFileSync(p, 'utf8'));
  const writeText =
    io.writeText ??
    ((p, text, mode) => {
      writeFileSync(p, text, { mode: mode ?? 0o644 });
      if (mode) chmodSync(p, mode);
    });
  const exists = io.exists ?? existsSync;
  const mkdirp = io.mkdirp ?? ((p) => mkdirSync(p, { recursive: true, mode: 0o755 }));

  const sshDir = join(io.home, '.ssh');
  const configPath = join(sshDir, 'config');
  const fleetDaoDir = join(io.home, '.fleet-dao');
  const franceSshPath = join(fleetDaoDir, 'france-ssh');
  const loginKey = join(io.home, '.ssh', 'fleet_login');

  let existing = '';
  if (exists(configPath)) {
    try {
      existing = readText(configPath);
    } catch (e) {
      const err = /** @type {{ code?: string, message?: string }} */ (e);
      return { ok: false, why: `${configPath} 读不了（${err.code ?? err.message}）` };
    }
  }

  /** @type {{ prefer?: 'wg' | 'carpool', franceWgHost?: string, francePublicHost?: string, jumpHost?: string, identityFile?: string }} */
  const mergeOpts = { prefer, identityFile: env.FLEET_FRANCE_IDENTITY ?? '~/.ssh/fleet_login' };
  if (env.FLEET_FRANCE_WG_HOST) mergeOpts.franceWgHost = env.FLEET_FRANCE_WG_HOST;
  if (env.FLEET_FRANCE_CARPOOL_HOST) mergeOpts.francePublicHost = env.FLEET_FRANCE_CARPOOL_HOST;
  else if (env.FLEET_FRANCE_WG_HOST) mergeOpts.francePublicHost = env.FLEET_FRANCE_WG_HOST;
  if (env.FLEET_FRANCE_JUMP_HOST) mergeOpts.jumpHost = env.FLEET_FRANCE_JUMP_HOST;
  const merged = mergeSshConfig(existing, mergeOpts);

  const franceLine = franceSshLine(prefer);
  let franceExists = false;
  if (exists(franceSshPath)) {
    try {
      franceExists = readText(franceSshPath).trim() !== '';
    } catch {
      franceExists = false;
    }
  }

  const notes = [];
  if (!exists(loginKey))
    notes.push(
      `没有 ${loginKey}：Host 写了也登不上，先把私钥放到这里（公钥须在法国对应用户的 authorized_keys）`,
    );

  if (io.checkOnly) {
    return {
      ok: true,
      checkOnly: true,
      wouldAdd: merged.added,
      wouldSkip: merged.skipped,
      franceSsh: franceExists ? 'present' : 'missing',
      preferHost: prefer === 'carpool' ? CARPOOL_HOST : WG_HOST,
      notes,
    };
  }

  if (merged.added.length) {
    mkdirp(sshDir);
    writeText(configPath, merged.config, 0o600);
  }
  if (!franceExists) {
    mkdirp(fleetDaoDir);
    writeText(franceSshPath, franceLine, 0o600);
  }

  return {
    ok: true,
    added: merged.added,
    skipped: merged.skipped,
    franceSsh: franceExists ? 'unchanged' : 'wrote',
    preferHost: prefer === 'carpool' ? CARPOOL_HOST : WG_HOST,
    notes,
  };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {'wg' | 'carpool'} */
  let prefer = 'wg';
  let checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') checkOnly = true;
    else if (a === '--prefer') {
      const v = argv[++i];
      if (v !== 'wg' && v !== 'carpool') {
        console.error(`--prefer 只认 wg 或 carpool，收到「${v ?? ''}」`);
        process.exit(2);
      }
      prefer = v;
    } else if (a === '--help' || a === '-h') {
      console.log(`用法：node ensure-france-ssh.mjs [--prefer wg|carpool] [--check]`);
      process.exit(0);
    } else {
      console.error(`不认的参数：${a}`);
      process.exit(2);
    }
  }
  return { prefer, checkOnly };
}

function main() {
  const { prefer, checkOnly } = parseArgs(process.argv.slice(2));
  const result = ensureFranceSsh({
    home: homedir(),
    prefer,
    checkOnly,
    env: process.env,
  });
  if (!result.ok) {
    console.error(result.why);
    process.exit(1);
  }
  if (result.checkOnly) {
    console.log(
      JSON.stringify(
        {
          wouldAdd: result.wouldAdd,
          wouldSkip: result.wouldSkip,
          franceSsh: result.franceSsh,
          preferHost: result.preferHost,
          notes: result.notes,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    [
      result.added?.length ? `加了 Host：${result.added.join(', ')}` : 'Host 已齐',
      result.skipped?.length ? `已有未改：${result.skipped.join(', ')}` : null,
      `france-ssh：${result.franceSsh}（指向 ${result.preferHost}）`,
      ...(result.notes ?? []),
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
