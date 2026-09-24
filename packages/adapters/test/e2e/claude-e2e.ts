// 真跑验收：经 reclaude 起两轮极小的会话，走插头的全部代码路径——
// 第一轮改文件并提交，判交付；第二轮续同一个会话，问第一轮的提交信息，证明上下文真的接上了。
// 在法国 VPS 上以执行体用户跑：node packages/adapters/test/e2e/claude-e2e.ts <reclaude 绝对路径> [模型]
// 花一点订阅额度（默认 haiku，两轮）；只动临时目录，不碰任何配置。
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { type ClaudeCodeRunSpec, judgeClaudeRun, runClaudeCode } from '../../src/claude-code/run.ts';
import { costOfThisRun } from '../../src/claude-code/stream.ts';
import { checkDelivery } from '../../src/delivery.ts';
import { sessionProcs } from '../../src/procs.ts';

const [reclaude, model = 'claude-haiku-4-5'] = process.argv.slice(2);
if (!reclaude) {
  console.error('用法：node claude-e2e.ts <reclaude 绝对路径> [模型]');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const origin = join(root, 'origin.git');
const tree = join(root, 'tree');
git(root, 'init', '-q', '--bare', '-b', 'main', origin);
git(root, 'init', '-q', '-b', 'main', tree);
git(tree, 'config', 'user.name', 'fleet-e2e');
git(tree, 'config', 'user.email', 'fleet-e2e');
git(tree, 'remote', 'add', 'origin', origin);
writeFileSync(join(tree, 'notes.md'), '# notes\n');
git(tree, 'add', '-A');
git(tree, 'commit', '-q', '-m', 'init');
git(tree, 'push', '-q', 'origin', 'HEAD:main');
git(tree, 'fetch', '-q', 'origin');

const sessionId = randomUUID();
const runId = `e2e-${sessionId.slice(0, 8)}`;
const events: ProgressEvent[] = [];
const base = (prompt: string, session: ClaudeCodeRunSpec['session']): ClaudeCodeRunSpec => ({
  runId,
  cwd: tree,
  prompt,
  model,
  session,
  permissionMode: 'bypassPermissions',
  env: { base: process.env, fleetApi: 'http://127.0.0.1:9', fleetToken: 'e2e-not-a-token' },
  limits: { wallClockMs: 10 * 60_000, idleMs: 5 * 60_000 },
  testCommands: ['git commit'],
});

const before = git(tree, 'rev-parse', 'HEAD');
const first = await runClaudeCode(
  base(
    '在 notes.md 末尾追加一行「- e2e 到此一游」，然后运行 `git add -A && git commit -m "e2e: 追加一行"`。做完只回复「好了」。',
    { mode: 'new', id: sessionId },
  ),
  { command: [reclaude], onEvent: (e) => events.push(e) },
);
const delivery = await checkDelivery({ cwd: tree, remote: 'origin', branch: 'main', since: before });
const firstVerdict = judgeClaudeRun(first, delivery);

// 第二轮不提交，还在后台留一个进程：交付判据不能认上一轮的提交，插头要把后台进程收掉
const afterFirst = git(tree, 'rev-parse', 'HEAD');
const firstRoundEvents = events.length;
const second = await runClaudeCode(
  base(
    '先运行 `nohup sleep 300 >/dev/null 2>&1 &` 在后台起一个进程，不用等它；然后回答：你刚才提交用的提交信息是什么？只回复提交信息本身。',
    { mode: 'resume', id: sessionId },
  ),
  { command: [reclaude], onEvent: (e) => events.push(e) },
);
const secondDelivery = await checkDelivery({
  cwd: tree,
  remote: 'origin',
  branch: 'main',
  since: afterFirst,
});
const secondVerdict = judgeClaudeRun(second);
const leftBehind = sessionProcs(runId);
const secondCost = costOfThisRun(second.stream.result, first.stream.result);
// 终帧只带最后一段回复（后台任务结束时模型还会再说一句），所以看这一轮说过的全部话
const secondSaid = events
  .slice(firstRoundEvents)
  .filter((e) => e.kind === 'say')
  .map((e) => String((e.payload as { text?: string }).text ?? ''))
  .join('\n');

const checks: [string, boolean][] = [
  ['第一轮判交付', firstVerdict.outcome === 'ok' && firstVerdict.reason === 'delivered'],
  ['第一轮实际模型和点名一致', first.stream.observedModel !== undefined && first.killed === undefined],
  ['第一轮读到改文件事件', events.some((e) => e.kind === 'file')],
  ['第一轮读到跑命令事件', events.some((e) => e.kind === 'tool')],
  ['第一轮读到提交（按测试命令认）', events.some((e) => e.kind === 'test')],
  ['第一轮有额度读数', first.stream.rateLimits.length > 0],
  ['续会话会话号不变', second.stream.sessionId === sessionId],
  ['续会话记得第一轮的提交信息', secondSaid.includes('e2e: 追加一行')],
  ['第二轮在后台留的进程被收掉了', second.stragglers >= 1],
  ['第二轮正常结束', secondVerdict.outcome === 'ok'],
  [
    '第二轮没有新提交：不靠上一轮的提交判交付',
    secondDelivery.state === 'not_delivered' && secondDelivery.newCommits === 0,
  ],
  [
    '第二轮的累计花费含第一轮，本轮花费按差算',
    secondCost !== undefined && secondCost > 0 && secondCost < (second.stream.result?.sessionCostUsd ?? 0),
  ],
  ['会话结束后没有留下带会话标记的进程', leftBehind.length === 0 && second.leftovers === 0],
];

const brief = (r: typeof first) => ({
  exitCode: r.exitCode,
  signal: r.signal,
  killed: r.killed,
  firstLineMs: r.firstLineMs,
  wallMs: r.wallMs,
  lines: r.lines,
  stragglers: r.stragglers,
  leftovers: r.leftovers,
  sessionId: r.stream.sessionId,
  observedModel: r.stream.observedModel,
  cliVersion: r.stream.cliVersion,
  filesChanged: r.stream.filesChanged,
  toolCalls: r.stream.toolCalls,
  result: r.stream.result,
  rateLimits: r.stream.rateLimits,
  unknownFrames: r.stream.unknownFrames,
  stderrTail: r.stderrTail.slice(-200),
});
console.log(
  JSON.stringify(
    {
      model,
      first: brief(first),
      delivery,
      firstVerdict,
      secondDelivery,
      secondCost,
      leftBehind,
      second: brief(second),
      secondVerdict,
      eventKinds: events.map((e) => e.kind),
      checks: Object.fromEntries(checks),
    },
    null,
    2,
  ),
);
rmSync(root, { recursive: true, force: true });
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
console.log(failed.length ? `FAIL：${failed.join('、')}` : 'PASS');
process.exitCode = failed.length ? 1 : 0;
