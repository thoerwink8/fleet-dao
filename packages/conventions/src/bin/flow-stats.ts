// 量最近几天的流程：node packages/conventions/src/bin/flow-stats.ts [--days 7] [--repo owner/名字]
// 用本机登录好的 gh（`gh api`）读 GitHub，只读。读不到、字段缺、列表为空一律报「没查成」退出 2，不打 0。
// 三个数的含义见 ../flow-stats.ts。
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { flowStats, formatFlowStats, parseDays } from '../flow-stats.ts';

function fail(why: string): never {
  console.error(why.startsWith('没查成') ? why : `没查成：${why}`);
  process.exit(2);
}

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

let repo = 'thoerwink8/fleet-dao';
let days = 7;
try {
  const { values } = parseArgs({
    options: {
      days: { type: 'string' },
      repo: { type: 'string' },
    },
    strict: true,
  });
  if (values.repo !== undefined) repo = values.repo;
  days = parseDays(values.days);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

try {
  const stats = flowStats(gh, { repo, days, now: new Date() });
  process.stdout.write(formatFlowStats(stats));
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
