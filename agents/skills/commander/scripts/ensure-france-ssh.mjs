#!/usr/bin/env node
// 恢复指挥官/box 到法国的 SSH 别名（#1732 验收第 4 条）：把 fleet-fr-wg 片段装进 ~/.ssh/config，
// 并核对 IdentityFile（fleet_login）和 Host myserver 是否在。不造私钥、不改法国 authorized_keys（那是 root/人闸）。
// 用法：node agents/skills/commander/scripts/ensure-france-ssh.mjs [--home <目录>] [--check]
// --check：只报告，不写；缺什么退出 1。默认缺片段就追加，仍缺钥匙/myserver 退出 1。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAGMENT = join(HERE, '../ssh/fleet-fr-wg.conf');
const BEGIN = '# BEGIN fleet-dao fleet-fr-wg (#1732)';
const END = '# END fleet-dao fleet-fr-wg (#1732)';

/**
 * @param {{ home: string, fragmentText: string, checkOnly?: boolean }} input
 * @returns {{ ok: boolean, wrote: boolean, lines: string[], missing: string[] }}
 */
export function ensureFranceSsh(input) {
  const sshDir = join(input.home, '.ssh');
  const configPath = join(sshDir, 'config');
  const keyPath = join(sshDir, 'fleet_login');
  const lines = [];
  const missing = [];

  const frag = `${input.fragmentText.replace(/\r\n/g, '\n').trimEnd()}\n`;
  let config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const hasBlock = config.includes(BEGIN) && config.includes(END);
  const hasHost = /^\s*Host\s+fleet-fr-wg\s*$/m.test(config);
  let wrote = false;

  if (!hasBlock && !hasHost) {
    if (!input.checkOnly) {
      if (!existsSync(sshDir)) mkdirSync(sshDir, { mode: 0o700 });
      const block = `${BEGIN}\n${frag}${END}\n`;
      config = config.trimEnd() === '' ? block : `${config.replace(/\s*$/, '')}\n\n${block}`;
      writeFileSync(configPath, config, { mode: 0o600 });
      wrote = true;
      lines.push(`已写入 ${configPath}（Host fleet-fr-wg）`);
    } else {
      missing.push('~/.ssh/config 里没有 Host fleet-fr-wg');
    }
  } else {
    lines.push('Host fleet-fr-wg 已在 ~/.ssh/config 里');
  }

  if (!/^\s*Host\s+myserver\s*$/m.test(config) && !/^\s*Host\s+myserver\s+/m.test(config)) {
    missing.push('~/.ssh/config 里没有 Host myserver（香港跳板；私有仓 workstation/ssh 的 config.sh 装）');
  } else {
    lines.push('Host myserver 在');
  }

  if (!existsSync(keyPath)) {
    missing.push(
      '~/.ssh/fleet_login 私钥不在（从私有仓 workstation/ssh 放，公钥须在法国 root authorized_keys）',
    );
  } else {
    lines.push('~/.ssh/fleet_login 在');
  }

  return { ok: missing.length === 0, wrote, lines, missing };
}

/**
 * @param {string[]} argv
 * @returns {{ help: true } | { home: string, checkOnly: boolean }}
 */
function parseArgs(argv) {
  let home = homedir();
  let checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') checkOnly = true;
    else if (a === '--home') {
      const v = argv[++i];
      if (!v) throw new Error('--home 后面要跟目录');
      home = v;
    } else if (a === '--help' || a === '-h') {
      return { help: true };
    } else {
      throw new Error(`认不出参数 ${a}`);
    }
  }
  return { home, checkOnly };
}

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if ('help' in args) {
    console.log(
      '用法：node ensure-france-ssh.mjs [--home <目录>] [--check]\n装 Host fleet-fr-wg；核对 myserver 与 fleet_login（#1732）',
    );
    return 0;
  }
  const fragmentText = readFileSync(FRAGMENT, 'utf8');
  const got = ensureFranceSsh({
    home: args.home,
    fragmentText,
    ...(args.checkOnly ? { checkOnly: true } : {}),
  });
  for (const l of got.lines) console.log(l);
  for (const m of got.missing) console.error(`还欠：${m}`);
  if (got.ok) {
    console.log('法国 SSH 别名就绪：ssh fleet-fr-wg');
    return 0;
  }
  console.error('法国 SSH 还没齐：补齐上面「还欠」后再跑一遍（或 --check 只查）');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
