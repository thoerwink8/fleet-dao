// 钩子每跑一次记一行各阶段耗时，查「钩子超时」用（决定 0093 B1）。
// 写到 ~/.fleet-dao/logs/hook-timing.jsonl，满 2MB 挪成 .1（只留一份旧的）。记不上不影响钩子本身，一律吞掉。
// 一行的字段（毫秒）：
//   launch：启动器 quiet-*.exe 进程创建到 node 进程创建（没经启动器的没有这项）
//   boot：node 进程创建到钩子脚本开始跑（含 node 冷启动、加载编译脚本和它 import 的模块）
//   read：读完 stdin；decide：判完；write：写完输出；total：node 进程创建到写完
// 看分布：node ~/.fleet-dao/hooks/hook-timing.mjs（打 p50/p90/p99/最大，按脚本分）
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isMainModule } from './is-main.mjs';

export const TIMING_LOG = join(homedir(), '.fleet-dao', 'logs', 'hook-timing.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * 开一份计时：mark 记阶段，done 落盘。时间都按 node 进程创建（performance.timeOrigin）起算。
 * @param {string} script 钩子脚本名
 * @param {{ log?: string, env?: NodeJS.ProcessEnv }} [opts] 测试换掉日志路径和环境
 */
export function hookTimer(script, { log = TIMING_LOG, env = process.env } = {}) {
  /** @type {Record<string, number>} */
  const marks = { boot: Math.round(performance.now()) };
  const t0 = Number(env.FLEET_HOOK_LAUNCHER_T0);
  const launch = Number.isFinite(t0) && t0 > 0 ? Math.round(performance.timeOrigin - t0) : undefined;
  return {
    /** @param {string} stage */
    mark(stage) {
      marks[stage] = Math.round(performance.now());
    },
    /**
     * @param {{ tool?: unknown, code?: number }} [extra]
     */
    done(extra = {}) {
      try {
        const row = {
          at: new Date().toISOString(),
          script,
          tool: typeof extra.tool === 'string' ? extra.tool : undefined,
          code: extra.code,
          ...(launch === undefined ? {} : { launch }),
          ...marks,
          total: Math.round(performance.now()),
        };
        mkdirSync(join(log, '..'), { recursive: true });
        try {
          if (statSync(log).size > MAX_BYTES) renameSync(log, `${log}.1`);
        } catch {
          // 还没有这个文件
        }
        appendFileSync(log, `${JSON.stringify(row)}\n`);
      } catch {
        // 记不上不影响钩子
      }
    },
  };
}

/**
 * 按脚本汇总分布（p50/p90/p99/最大，毫秒）。launch 有值时 total 加上它，算到启动器起来那一刻。
 * @param {string} text jsonl 全文
 * @param {number} [sinceMs] 只算这个时间（epoch 毫秒）之后的
 */
export function summarize(text, sinceMs = 0) {
  /** @type {Record<string, Record<string, number[]>>} */
  const by = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    /** @type {Record<string, unknown>} */
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (Date.parse(String(r.at)) < sinceMs) continue;
    const name = String(r.script);
    /** @type {Record<string, number[]>} */
    const s = by[name] ?? {};
    by[name] = s;
    /** @param {string} k @param {number} v */
    const add = (k, v) => {
      const list = s[k] ?? [];
      list.push(v);
      s[k] = list;
    };
    for (const k of ['launch', 'boot', 'read', 'decide', 'write', 'total']) {
      const v = r[k];
      if (typeof v === 'number') add(k, v);
    }
    if (typeof r.launch === 'number' && typeof r.total === 'number') add('endToEnd', r.launch + r.total);
  }
  /** @type {Record<string, Record<string, { n: number, p50: number, p90: number, p99: number, max: number }>>} */
  const out = {};
  for (const [script, stages] of Object.entries(by)) {
    out[script] = {};
    for (const [k, vs] of Object.entries(stages)) {
      vs.sort((a, b) => a - b);
      const at = (/** @type {number} */ q) => vs[Math.min(vs.length - 1, Math.floor(vs.length * q))] ?? 0;
      out[script][k] = { n: vs.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: vs.at(-1) ?? 0 };
    }
  }
  return out;
}

if (isMainModule(import.meta)) {
  const hours = Number(process.argv[2] ?? 24 * 7);
  let text = '';
  try {
    text = readFileSync(TIMING_LOG, 'utf8');
  } catch (err) {
    process.stderr.write(`读不到 ${TIMING_LOG}（${err instanceof Error ? err.message : String(err)}）\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(summarize(text, Date.now() - hours * 3600_000), null, 2)}\n`);
}
