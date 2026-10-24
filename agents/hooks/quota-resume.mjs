#!/usr/bin/env node
// 续跑巡检的判断（决定 0120 第 5 条，#3687）：桌面端定时任务每 30 分钟跑 `due`，拿到该续的会话后用桌面端的
// send_message 发一句「继续」，再跑 `done` 记账。判断全在这里，定时任务的会话只发消息，模型开销最小。
// - 读 quota-stops.jsonl（StopFailure 钩子 quota-stop.mjs 写的），每个会话只看最后一次停下。
// - 限流（rate_limit、overloaded、429）停 5 分钟后续；额度停下的：之后拼车开了新窗口（carpool-clock 打过新一枪）、
//   本机挂着独享、或已过 5 小时，就续。
// - 停下后人自己发过消息的、停了超过 24 小时的，记成跳过，不续。
// - 会话号对应：桌面端 %APPDATA%/Claude/claude-code-sessions/**/local_*.json 里的 cliSessionId。对不上的报出来，不猜。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const M = 60_000;
const H = 60 * M;

/** @typedef {{ at: string, session_id?: string, error?: string, error_details?: string }} StopRow */
/** @typedef {{ lastProbeAt?: number, org?: 'carpool' | 'solo' }} Clock */

/**
 * 这一行停下现在该不该续：'resume' | 'wait' | 'expire'。纯函数。
 * @param {StopRow} row
 * @param {Clock} clock
 * @param {number} now
 */
export function verdict(row, clock, now) {
  const at = Date.parse(row.at);
  if (!Number.isFinite(at) || now - at > 24 * H) return 'expire';
  const text = `${row.error ?? ''} ${row.error_details ?? ''}`;
  if (/rate_limit|overloaded|\b429\b/i.test(text) && !/usage limit|额度|quota/i.test(text)) {
    return now - at >= 5 * M ? 'resume' : 'wait';
  }
  if ((clock.lastProbeAt ?? 0) > at || clock.org === 'solo' || now - at >= 5 * H) return 'resume';
  return 'wait';
}

const dir = join(homedir(), '.fleet-dao', 'state');
const stopsFile = join(dir, 'quota-stops.jsonl');
const doneFile = join(dir, 'quota-resume.json');
const clockFile = join(dir, 'carpool-clock.json');
const sessionsRoot = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'Claude',
  'claude-code-sessions',
);

/** @param {string} f */
function readJson(f) {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

/** cliSessionId → { local, latestUserFrameAt }。 */
function desktopSessions() {
  /** @type {Map<string, { local: string, userAt: number }>} */
  const map = new Map();
  /** @param {string} d */
  const walk = (d) => {
    for (const name of existsSync(d) ? readdirSync(d) : []) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^local_.*\.json$/.test(name)) {
        const j = readJson(p);
        if (typeof j.cliSessionId === 'string')
          map.set(j.cliSessionId, { local: j.sessionId, userAt: Number(j.latestUserFrameAt) || 0 });
      }
    }
  };
  walk(sessionsRoot);
  return map;
}

function due() {
  const now = Date.now();
  /** @type {Record<string, string>} */
  const done = readJson(doneFile).done ?? {};
  /** @type {Map<string, StopRow>} */
  const last = new Map();
  for (const line of existsSync(stopsFile) ? readFileSync(stopsFile, 'utf8').split('\n') : []) {
    try {
      const row = /** @type {StopRow} */ (JSON.parse(line));
      if (row.session_id) last.set(row.session_id, row);
    } catch {
      // 空行、写一半的行跳过。
    }
  }
  const clock = /** @type {Clock} */ (readJson(clockFile));
  const sessions = desktopSessions();
  const out = [];
  const unmatched = [];
  for (const [cli, row] of last) {
    const key = `${cli}@${row.at}`;
    if (done[key]) continue;
    const s = sessions.get(cli);
    const v = verdict(row, clock, now);
    if (v === 'expire' || (s && s.userAt > Date.parse(row.at))) {
      done[key] = v === 'expire' ? '超过 24 小时，跳过' : '人已经接着发过消息，跳过';
      continue;
    }
    if (v !== 'resume') continue;
    if (!s) unmatched.push({ cli, at: row.at });
    else out.push({ local: s.local, cli, at: row.at, error: row.error ?? '' });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(doneFile, JSON.stringify({ done }, null, 2));
  console.log(JSON.stringify({ resume: out, unmatched }));
}

/**
 * @param {string} cli
 * @param {string} at
 * @param {string} result
 */
function markDone(cli, at, result) {
  const done = readJson(doneFile).done ?? {};
  done[`${cli}@${at}`] = `${new Date().toISOString()} ${result}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(doneFile, JSON.stringify({ done }, null, 2));
  console.log('记下了');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, a = '', b = '', c = 'sent'] = process.argv.slice(2);
  if (cmd === 'due') due();
  else if (cmd === 'done' && a && b) markDone(a, b, c);
  else {
    console.log('用法：node quota-resume.mjs due | done <cliSessionId> <at> [结果]');
    process.exitCode = 2;
  }
}
