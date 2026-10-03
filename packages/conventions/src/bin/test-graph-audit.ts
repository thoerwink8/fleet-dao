#!/usr/bin/env node
// 拿真实运行时核对测试影响图（test-graph.ts）：跑一轮 vitest 记下每个测试真读的仓内文件，比出图漏掉的边。
// 每晚定时跑；本机想快点就只给几个测试文件或目录。
// 用法：node packages/conventions/src/bin/test-graph-audit.ts [测试文件或目录…]
// 退出码：有会选漏的漏边（非 opaque 测试上）→ 1；没查成（建不出图、一条流水都没有、该记到的没记到）→ 2；干净 → 0。
import { execFileSync } from 'node:child_process';
import { fsRepo } from '../repo.ts';
import { buildTestGraph } from '../test-graph.ts';
import { compareTrace, formatAudit, realMisses, runTrace } from '../test-graph-audit.ts';

const args = process.argv.slice(2);
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim().replace(/\\/g, '/');
try {
  const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const graph = buildTestGraph(fsRepo(root), { files });
  const run = await runTrace(root, args);
  const report = compareTrace(run.records, graph, root, args.length > 0 ? { scope: args } : {});
  console.log(formatAudit(report));
  if (run.failed.length > 0) console.log(`红了的测试（核对只算下限）：${run.failed.join(' ')}`);
  console.log(`流水：${run.outDir}（vitest 退出码 ${run.status}）`);
  const leaking = realMisses(report).filter((m) => !report.opaqueTests.has(m.test));
  if (leaking.length > 0) process.exit(1);
  if (report.missingTrace.length > 0) process.exit(2);
} catch (e) {
  console.error(`没查成：${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
