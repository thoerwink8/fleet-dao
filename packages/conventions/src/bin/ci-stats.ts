// 量某个工作流最近几轮：node packages/conventions/src/bin/ci-stats.ts [--workflow ci.yml] [--n 40] [--event push|pull_request] [--since 2026-10-05T00:00:00Z] [--repo owner/名字]
// 用本机登录好的 gh（`gh api`）读 GitHub，只读；读不到、认不出的时间一律报错退出 2，不当 0 秒。
// 数字的含义见 ../ci-stats.ts；怎么量见 docs/ci-speedup-plan.md「怎么量」。被取消的轮次不算（没跑完整）。
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { type JobInput, type RunInput, rowOf, summarize } from '../ci-stats.ts';

function fail(why: string): never {
  console.error(`没量成：${why}`);
  process.exit(2);
}

let opts: { workflow: string; n: number; event: string; since: string; repo: string };
try {
  const { values } = parseArgs({
    options: {
      workflow: { type: 'string' },
      n: { type: 'string' },
      event: { type: 'string' },
      since: { type: 'string' },
      repo: { type: 'string' },
    },
    strict: true,
  });
  opts = {
    workflow: values.workflow ?? 'ci.yml',
    n: Number(values.n ?? 40),
    event: values.event ?? '',
    since: values.since ?? '',
    repo: values.repo ?? 'thoerwink8/fleet-dao',
  };
} catch (e) {
  fail(`参数不对（${e instanceof Error ? e.message : String(e)}）`);
}
if (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > 300) fail('--n 要 1 到 300 的整数');
if (!/^[\w.-]+\.ya?ml$/.test(opts.workflow)) fail('--workflow 要是工作流文件名');
if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) fail('--repo 要是 owner/名字');
if (opts.event !== '' && !/^[a-z_]+$/.test(opts.event)) fail('--event 认不出');

function gh(path: string): unknown {
  let last = '';
  for (let i = 0; i < 3; i++) {
    const r = spawnSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status === 0) {
      try {
        return JSON.parse(r.stdout);
      } catch {
        last = '回的不是 JSON';
      }
    } else last = r.stderr.trim() || `退出 ${r.status}`;
  }
  return fail(`gh api ${path.split('?')[0]}：${last}`);
}

const runs: RunInput[] = [];
for (let page = 1; runs.length < opts.n && page <= 10; page++) {
  const ev = opts.event ? `&event=${opts.event}` : '';
  const body = gh(
    `repos/${opts.repo}/actions/workflows/${opts.workflow}/runs?per_page=50&page=${page}&status=completed${ev}`,
  ) as { workflow_runs?: (RunInput & { conclusion: string | null })[] };
  if (!Array.isArray(body.workflow_runs)) fail('运行列表认不出（没有 workflow_runs）');
  if (body.workflow_runs.length === 0) break;
  for (const r of body.workflow_runs) {
    if (opts.since && r.created_at < opts.since) continue;
    if (r.conclusion === 'cancelled') continue;
    runs.push(r);
    if (runs.length >= opts.n) break;
  }
}
if (runs.length === 0) fail('一轮都没取到（过滤太严、或工作流名不对）');

const rows = runs.map((run) => {
  const body = gh(`repos/${opts.repo}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`) as {
    jobs?: JobInput[];
  };
  if (!Array.isArray(body.jobs)) fail(`运行 ${run.id} 的 job 列表认不出`);
  try {
    return rowOf(run, body.jobs);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
});
for (const x of rows) {
  console.log(
    `${x.id} ${x.event.padEnd(12)} ${x.sha} ${x.conclusion.padEnd(8)} 墙钟 ${String(x.wallSec).padStart(4)}s 排队 ${String(x.queueSec).padStart(3)}s 机器 ${(x.machineSec / 60).toFixed(1).padStart(5)}min jobs=${x.jobs} ${JSON.stringify(x.perJob)}`,
  );
}
for (const s of summarize(rows)) {
  console.log(
    `== ${s.event}（${s.runs} 轮）墙钟 中位 ${s.wallMedian}s 最大 ${s.wallMax}s；排队中位 ${s.queueMedian}s；job 数中位 ${s.jobsMedian}；机器分钟 中位 ${s.machineMinMedian.toFixed(1)} 合计 ${s.machineMinTotal.toFixed(0)}`,
  );
}
