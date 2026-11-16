// 找出「已收轮、没发出回报」的执行会话：node check-reports.mjs [--hours 12] [--root <会话目录>]
// 会话自己发回报，覆盖不了它自己被停、崩溃、模型报错的情况；指挥官巡检跑这个，输出 ALERT 行。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SENT_MARK = 'ok 已发给';

/**
 * @param {string} root 某个 agent 的会话目录，例如 ~/.mirasim/sessions/pi
 * @param {{ now?: number, hours?: number }} [opt]
 * @returns {{ id: string, state: string, why: string }[]}
 */
export function scanUnreported(root, opt = {}) {
  const now = opt.now ?? Date.now();
  const since = now - (opt.hours ?? 12) * 3600_000;
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root)) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(root, dir, 'record.json'), 'utf8'));
    } catch {
      continue;
    }
    if (rec.runState === 'running' || Date.parse(rec.updatedAt) < since) continue;
    let turns = '';
    try {
      turns = readFileSync(join(root, dir, 'turns.jsonl'), 'utf8');
    } catch {
      // 没有轮记录：一次都没跑起来，也算没回报
    }
    if (turns.includes(SENT_MARK)) continue;
    const why = rec.runDetail ? String(rec.runDetail).slice(0, 160) : lastText(turns);
    out.push({ id: dir.slice(0, 8), state: String(rec.runState), why });
  }
  return out;
}

/** @param {string} turns */
function lastText(turns) {
  const lines = turns.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = [...lines[i].matchAll(/"(?:text|appendText)":"((?:[^"\\]|\\.)+)"/g)];
    if (m.length) {
      try {
        return JSON.parse(`"${m[m.length - 1][1]}"`)
          .replace(/\s+/g, ' ')
          .slice(-160);
      } catch {
        return '';
      }
    }
  }
  return '没有输出';
}

/** @param {string[]} argv */
export function run(argv, log = console.log) {
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = get('--root') ?? join(homedir(), '.mirasim', 'sessions', 'pi');
  const rows = scanUnreported(root, { hours: Number(get('--hours') ?? 12) });
  for (const r of rows) log(`ALERT ${r.id} ${r.state} 没发回报：${r.why}`);
  if (!rows.length) log('没有收轮却没回报的会话');
  return rows.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(run(process.argv.slice(2)));
