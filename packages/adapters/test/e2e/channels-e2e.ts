// 真跑验收（P3 各渠道）：在一个临时 git 仓里跑两轮极小的会话，走插头的全部代码路径——
// 第一轮改文件并提交，判交付；第二轮续同一个会话，问第一轮的提交信息，证明上下文真的接上了，而且第二轮不靠上一轮的提交判交付。
// 在法国 VPS 上以已经登录好的用户跑（只用订阅 / Mirasim 中转额度，不碰按量计费的接口）：
//   node packages/adapters/test/e2e/channels-e2e.ts cursor <cursor-agent 绝对路径> [模型，默认 auto]
//   node packages/adapters/test/e2e/channels-e2e.ts grok <grok 绝对路径> [模型，默认 grok-4.7]
//   node packages/adapters/test/e2e/channels-e2e.ts mirasim <执行体> <route> <令牌文件> [期望模型] [账本目录] [点名模型]
// 只动临时目录（TMPDIR 下），不碰任何配置。
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { cursorRunSummary, runCursorAgent } from '../../src/cursor/run.ts';
import { checkDelivery } from '../../src/delivery.ts';
import { grokRunSummary, runGrok } from '../../src/grok/run.ts';
import { judgeRun, type RunSummary } from '../../src/judge.ts';
import {
  type MirasimRoute,
  type MirasimRunReport,
  mirasimRouting,
  mirasimRunSummary,
  runMirasim,
} from '../../src/mirasim/run.ts';
import { mirasimConnector } from '../../src/mirasim/wire.ts';
import { sessionProcs } from '../../src/procs.ts';

const [channel, ...rest] = process.argv.slice(2);
if (!channel || !['cursor', 'grok', 'mirasim'].includes(channel)) {
  console.error('用法见文件头');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'fleet-p3-e2e-'));
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

const runId = `e2e-${channel}-${randomUUID().slice(0, 8)}`;
const events: ProgressEvent[] = [];
const onEvent = (e: ProgressEvent) => void events.push(e);
const env = { base: process.env, fleetApi: 'http://127.0.0.1:9', fleetToken: 'e2e-not-a-token' };
const limits = { wallClockMs: 10 * 60_000, idleMs: 5 * 60_000 };
const testCommands = ['git commit'];
const FIRST = `在 notes.md 末尾追加一行「- ${channel} e2e 到此一游」，然后运行 \`git add -A && git commit -m "e2e: 追加一行"\`。做完只回复「好了」。`;
const SECOND = '你刚才提交用的提交信息是什么？只回复提交信息本身。';

interface Round {
  summary: RunSummary;
  /** 下一轮续跑用的会话号。 */
  resumeId?: string;
  brief: Record<string, unknown>;
  leftovers?: number | undefined;
}

let round: (prompt: string, resumeId?: string) => Promise<Round>;
if (channel === 'cursor') {
  const [bin, model = 'auto'] = rest;
  if (!bin) throw new Error('要给 cursor-agent 的绝对路径');
  round = async (prompt, resumeId) => {
    const r = await runCursorAgent(
      {
        runId,
        cwd: tree,
        prompt,
        model,
        session: resumeId ? { mode: 'resume', id: resumeId } : { mode: 'new' },
        force: true,
        env,
        limits,
        testCommands,
      },
      { command: [bin], onEvent },
    );
    const summary = cursorRunSummary(r);
    return {
      summary,
      ...(summary.sessionId ? { resumeId: summary.sessionId } : {}),
      leftovers: r.leftovers,
      brief: {
        exitCode: r.exitCode,
        killed: r.killed,
        wallMs: r.wallMs,
        initModel: r.stream.initModel,
        stream: { ...r.stream },
        stderrTail: r.stderrTail.slice(-300),
      },
    };
  };
} else if (channel === 'grok') {
  const [bin, model = 'grok-4.7'] = rest;
  if (!bin) throw new Error('要给 grok 的绝对路径');
  round = async (prompt, resumeId) => {
    const r = await runGrok(
      {
        runId,
        cwd: tree,
        prompt,
        model,
        session: resumeId ? { mode: 'resume', id: resumeId } : { mode: 'new', id: randomUUID() },
        alwaysApprove: true,
        env,
        limits,
        testCommands,
      },
      { command: [bin], onEvent },
    );
    const summary = grokRunSummary(r);
    return {
      summary,
      ...(summary.sessionId ? { resumeId: summary.sessionId } : {}),
      leftovers: r.leftovers,
      brief: {
        exitCode: r.exitCode,
        killed: r.killed,
        wallMs: r.wallMs,
        end: r.stream.end,
        errors: r.stream.errors,
        unknownFrames: r.stream.unknownFrames,
        stderrTail: r.stderrTail.slice(-300),
      },
    };
  };
} else {
  const [agent, route, tokenFile, expectModel, ledgerDir, model] = rest;
  if (!agent || !route || !tokenFile) throw new Error('要给执行体、route、令牌文件');
  const connect = mirasimConnector({ port: 4316, tokenFile });
  let previous: MirasimRunReport | undefined;
  round = async (prompt, resumeId) => {
    const r = await runMirasim(
      {
        runId,
        cwd: tree,
        prompt,
        agent,
        route: route as MirasimRoute,
        ...(expectModel && expectModel !== '-' ? { expectModel } : {}),
        ...(model ? { model } : {}),
        session: resumeId ? { mode: 'resume', key: resumeId } : { mode: 'new' },
        limits,
        testCommands,
      },
      { connect, onEvent, ...(ledgerDir && ledgerDir !== '-' ? { ledgerDir } : {}) },
    );
    // 续跑那轮的会话累计用量要按上一轮求差
    const summary = mirasimRunSummary(r, previous);
    previous = r;
    return {
      summary,
      ...(r.sessionKey ? { resumeId: r.sessionKey } : {}),
      brief: {
        serverVersion: r.serverVersion,
        sessionKey: r.sessionKey,
        launchError: r.launchError,
        killed: r.killed,
        stop: r.stop,
        watchError: r.watchError,
        terminal: r.terminal,
        model: r.session.state.model,
        usage: r.session.state.usage,
        routing: mirasimRouting(r) ?? r.ledger,
        foreignFrames: r.foreignFrames,
        resubscribes: r.resubscribes,
        wallMs: r.wallMs,
        firstProgressMs: r.firstProgressMs,
      },
    };
  };
}

const before = git(tree, 'rev-parse', 'HEAD');
const first = await round(FIRST);
const delivery = await checkDelivery({ cwd: tree, remote: 'origin', branch: 'main', since: before });
const firstVerdict = judgeRun(first.summary.facts, delivery);
const firstEvents = events.length;
const afterFirst = git(tree, 'rev-parse', 'HEAD');
const second = await round(SECOND, first.resumeId);
const secondDelivery = await checkDelivery({
  cwd: tree,
  remote: 'origin',
  branch: 'main',
  since: afterFirst,
});
const secondVerdict = judgeRun(second.summary.facts);
const secondSaid = events
  .slice(firstEvents)
  .filter((e) => e.kind === 'say')
  .map((e) => String((e.payload as { text?: string }).text ?? ''))
  .join('\n');
const leftBehind = sessionProcs(runId);
const kinds = events.slice(0, firstEvents).map((e) => e.kind);

const checks: [string, boolean][] = [
  ['第一轮判交付', firstVerdict.outcome === 'ok' && firstVerdict.reason === 'delivered'],
  ['第一轮读到工具事件', kinds.includes('tool')],
  ['第一轮读到改文件或提交（按测试命令认）', kinds.includes('file') || kinds.includes('test')],
  ['第一轮有用量读数', Object.keys(first.summary.usage).length > 0 || channel === 'mirasim'],
  ['续会话会话号不变', Boolean(first.resumeId) && second.summary.sessionId === first.resumeId],
  ['续会话记得第一轮的提交信息', secondSaid.includes('e2e: 追加一行')],
  ['第二轮正常结束', secondVerdict.outcome === 'ok'],
  [
    '第二轮没有新提交：不靠上一轮的提交判交付',
    secondDelivery.state === 'not_delivered' && secondDelivery.newCommits === 0,
  ],
  ['会话结束后没有留下带会话标记的进程', leftBehind.length === 0 && (second.leftovers ?? 0) === 0],
];
console.log(
  JSON.stringify(
    {
      channel,
      args: rest.filter((a) => !a.includes('token')),
      first: { ...first.brief, summary: first.summary },
      delivery,
      firstVerdict,
      second: { ...second.brief, summary: second.summary },
      secondDelivery,
      secondVerdict,
      secondSaid,
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
