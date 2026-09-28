// 真跑验收：调工具前那条钩子经 --settings 带上以后，引擎起的那种无头会话（-p、stream-json、--setting-sources project、
// bypassPermissions）里真拦得住本机 reclaude org use，正文里写到「gh issue create」的不拦，正常活（改文件、Read、提交）不受影响。
// 在法国 VPS 上以登录好的会话用户跑（不进 scope）：
//   FLEET_ENV=development node packages/adapters/test/e2e/claude-guard-e2e.ts <reclaude 绝对路径> [模型] [钩子脚本]
// 钩子脚本不给就用仓里这份（PRETOOL_SCRIPT）。花一点订阅额度（默认 haiku，两轮）；只动临时目录，不碰任何配置。
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { PRETOOL_SCRIPT } from '../../src/claude-code/args.ts';
import { type ClaudeCodeRunSpec, judgeClaudeRun, runClaudeCode } from '../../src/claude-code/run.ts';
import { checkDelivery } from '../../src/delivery.ts';
import type { ToolPayload } from '../../src/types.ts';

const [reclaude, model = 'claude-haiku-4-5', pretoolScript = PRETOOL_SCRIPT] = process.argv.slice(2);
if (!reclaude) {
  console.error('用法：node claude-guard-e2e.ts <reclaude 绝对路径> [模型] [钩子脚本]');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'fleet-guard-e2e-'));
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

const events: ProgressEvent[] = [];
const base = (prompt: string, id: string): ClaudeCodeRunSpec => ({
  runId: `guard-e2e-${id.slice(0, 8)}`,
  cwd: tree,
  prompt,
  model,
  session: { mode: 'new', id },
  permissionMode: 'bypassPermissions',
  pretoolScript,
  env: { base: process.env, fleetApi: 'http://127.0.0.1:9', fleetToken: 'e2e-not-a-token' },
  limits: { wallClockMs: 10 * 60_000, idleMs: 5 * 60_000 },
  testCommands: ['git commit'],
});
const toolEnds = (from: number) =>
  events
    .slice(from)
    .filter((e) => e.kind === 'tool')
    .map((e) => e.payload as ToolPayload)
    .filter((p) => p.phase === 'end');

const checks: [string, boolean, string][] = [];
const check = (what: string, ok: boolean, detail = '') => checks.push([what, ok, detail]);

// 第一轮：正常活，Bash、Read 一个都不该被拦。读文件不再挂这条钩子。
const before = git(tree, 'rev-parse', 'HEAD');
const first = await runClaudeCode(
  base(
    '在 notes.md 末尾追加一行「- 钩子验收」；用 Read 工具读一遍 notes.md；用 Grep 工具（你的 Grep 工具本身，不是 Bash 里的 grep 命令）在当前目录搜「钩子验收」；然后运行 `git add -A && git commit -m "e2e: 钩子验收"`。做完只回复「好了」。',
    randomUUID(),
  ),
  { command: [reclaude], onEvent: (e) => events.push(e) },
);
const firstTools = toolEnds(0);
const delivery = await checkDelivery({ cwd: tree, remote: 'origin', branch: 'main', since: before });
check(
  '第一轮正常结束',
  judgeClaudeRun(first, delivery).outcome === 'ok',
  JSON.stringify(judgeClaudeRun(first, delivery)),
);
check('第一轮提交了', git(tree, 'rev-parse', 'HEAD') !== before);
for (const name of ['Bash', 'Read']) {
  check(
    `第一轮用了 ${name}`,
    firstTools.some((t) => t.name === name),
  );
}
check(
  '第一轮一个工具都没被拦',
  firstTools.every((t) => t.ok),
  firstTools
    .filter((t) => !t.ok)
    .map((t) => `${t.name}：${t.error ?? ''}`)
    .join('；'),
);

// 第二轮：正文里的字样放行，真正执行的切号被拦
const afterFirst = events.length;
const second = await runClaudeCode(
  base(
    "请依次做两步，每步做完照实说工具返回了什么：1）用 Bash 运行 cat <<'EOF' 然后换行写「不要直接 gh issue create」再换行写 EOF；2）用 Bash 运行 reclaude org use e2e-should-block。",
    randomUUID(),
  ),
  { command: [reclaude], onEvent: (e) => events.push(e) },
);
const secondTools = toolEnds(afterFirst);
const bashEnds = secondTools.filter((t) => t.name === 'Bash');
check('第二轮用了 Bash', bashEnds.length > 0, '没试就等于没验');
check(
  '正文里写到开单命令的那步没被拦',
  bashEnds.some((t) => t.ok && (t.summary + (t.error ?? '')).includes('issue')),
  bashEnds.map((t) => `${t.ok ? 'ok' : 'blocked'} ${t.summary}`).join('；'),
);
check(
  '切号被钩子拦下',
  bashEnds.some((t) => !t.ok && (t.error ?? '').includes('fleet-guard')),
  bashEnds.map((t) => `${t.ok ? 'ok' : 'blocked'} ${t.error ?? t.summary}`).join('；'),
);

console.log(
  JSON.stringify(
    {
      cliVersion: first.stream.cliVersion,
      model: first.stream.observedModel,
      pretoolScript,
      first: {
        exitCode: first.exitCode,
        tools: firstTools.map((t) => `${t.name}:${t.ok ? 'ok' : 'blocked'}`),
      },
      second: {
        exitCode: second.exitCode,
        tools: secondTools.map((t) => `${t.name}:${t.ok ? 'ok' : 'blocked'}`),
        firstBlock: bashEnds.find((t) => !t.ok)?.error?.split('\n')[0],
      },
    },
    null,
    2,
  ),
);
for (const [what, ok, detail] of checks)
  console.log(`${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : `：${detail}`}`);
rmSync(root, { recursive: true, force: true });
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
