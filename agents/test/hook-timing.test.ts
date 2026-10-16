// 钩子各阶段耗时（agents/hooks/hook-timing.mjs）：每跑一次记一行，查「钩子超时」的根子用（决定 0093 B1）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hookTimer, summarize } from '../hooks/hook-timing.mjs';
import { runChild } from './child.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'hook-timing-'));
  dirs.push(d);
  return d;
}

describe('hookTimer', () => {
  it('一行带脚本、工具、退出码和各阶段（按 node 进程创建起算，单调不减）', () => {
    const log = join(tmp(), 'logs', 'hook-timing.jsonl');
    const t = hookTimer('pretool.mjs', { log, env: {} });
    t.mark('read');
    t.mark('decide');
    t.mark('write');
    t.done({ tool: 'Bash', code: 2 });
    const row = JSON.parse(readFileSync(log, 'utf8').trim()) as Record<string, unknown>;
    expect(row).toMatchObject({ script: 'pretool.mjs', tool: 'Bash', code: 2 });
    expect(row.launch).toBeUndefined();
    const stages = ['boot', 'read', 'decide', 'write', 'total'].map((k) => row[k] as number);
    for (const v of stages) expect(typeof v).toBe('number');
    expect([...stages].sort((a, b) => a - b)).toEqual(stages);
  });

  it('经启动器起的：FLEET_HOOK_LAUNCHER_T0 算出启动器到 node 那一段（launch）', () => {
    const log = join(tmp(), 'h.jsonl');
    const t0 = Math.round(performance.timeOrigin) - 1500;
    hookTimer('pretool.mjs', { log, env: { FLEET_HOOK_LAUNCHER_T0: String(t0) } }).done();
    const row = JSON.parse(readFileSync(log, 'utf8')) as { launch: number };
    expect(row.launch).toBeGreaterThanOrEqual(1499);
    expect(row.launch).toBeLessThan(1600);
  });

  it('日志写不进（目录是个文件）：不抛，钩子照常', () => {
    const d = tmp();
    writeFileSync(join(d, 'logs'), 'x');
    expect(() => hookTimer('pretool.mjs', { log: join(d, 'logs', 'h.jsonl'), env: {} }).done()).not.toThrow();
  });
});

describe('summarize', () => {
  it('按脚本出 p50/p90/p99/最大；坏行、太早的跳过；有 launch 的另算 endToEnd', () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ at: '2026-10-14T10:00:00Z', script: 'pretool.mjs', boot: 50, total: i + 1 }),
      ),
      JSON.stringify({ at: '2026-10-14T10:00:00Z', script: 'main-thread.mjs', launch: 100, total: 20 }),
      JSON.stringify({ at: '2026-01-01T00:00:00Z', script: 'pretool.mjs', total: 99999 }),
      '{坏行',
    ].join('\n');
    const s = summarize(rows, Date.parse('2026-10-01T00:00:00Z'));
    expect(s['pretool.mjs']?.total).toEqual({ n: 100, p50: 51, p90: 91, p99: 100, max: 100 });
    expect(s['main-thread.mjs']?.endToEnd).toEqual({ n: 1, p50: 120, p90: 120, p99: 120, max: 120 });
  });
});

describe('真跑 pretool.mjs', () => {
  it('放行、拦下都各记一行，钩子的退出码和输出不变', () => {
    const home = tmp();
    const hook = fileURLToPath(new URL('../hooks/pretool.mjs', import.meta.url));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const run = (command: string) =>
      runChild(process.execPath, [hook], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: home }),
        env,
      });
    expect(run('echo hi').status).toBe(0);
    // 反引号那条不看本机有没有会话、哪台机器都拦（切号那条要真查本机进程，CI 上没有 Claude 会放行）
    expect(run('echo `date`').status).toBe(2);
    const rows = readFileSync(join(home, '.fleet-dao', 'logs', 'hook-timing.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { script: string; tool: string; code: number; decide: number });
    expect(rows.map((r) => [r.script, r.tool, r.code])).toEqual([
      ['pretool.mjs', 'Bash', 0],
      ['pretool.mjs', 'Bash', 2],
    ]);
    for (const r of rows) expect(typeof r.decide).toBe('number');
  });
});
