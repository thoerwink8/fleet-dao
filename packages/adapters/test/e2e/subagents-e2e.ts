// 真跑验收（#1641 第 6 片，决定 0087 改成三个角色）：Mirasim 中转起的 claude 会话里，同名覆盖内置的三个子代理
// （Explore 斥候 Haiku、general-purpose 工人 Sonnet、Plan 设计 Opus）真用上了、各自的模型对得上。判账本里的上游模型、
// 最终回答里三个角色各一行、会话结局、快照模型核对。
// 并发上限（CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=2）只在 settings.local.json 里写上，这里不单独触发超限，也不判它。
// 以登录好的会话用户（即 Mirasim 服务的那个用户）、带 FLEET_ENV=development 跑：
//   FLEET_ENV=development node packages/adapters/test/e2e/subagents-e2e.ts <令牌文件> <账本目录> <agents 来源目录（含 agents/subagents 的检出或发布目录）> [主会话模型，默认 claude-sonnet-5-5]
// 只动临时目录（TMPDIR 下），不碰任何配置；跑完删临时目录（失败也删，路径会打印出来）。
// 退出码：0 全过，1 有没过，2 有没查成（没过优先于没查成）。
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { MAX_CONCURRENT_SUBAGENTS } from '../../src/claude-code/run.ts';
import { judgeRun } from '../../src/judge.ts';
import { mirasimRouting, mirasimRunSummary, runMirasim } from '../../src/mirasim/run.ts';
import { mirasimConnector } from '../../src/mirasim/wire.ts';
import { runChildOk } from '../child.ts';

const [tokenFile, ledgerDir, agentsSource, mainModel = 'claude-sonnet-5-5'] = process.argv.slice(2);
if (!tokenFile || !ledgerDir || !agentsSource) {
  console.error('用法见文件头');
  process.exit(2);
}
// 端口从令牌文件名 local-<端口>.token 读，和引擎 discoverMirasimEndpoint（engine/src/real/index.ts）同一个认法。
// 先前写死 4316：法国 fleet-agent-carpool 的服务在 4318，连不上，整次「没查成」（#1641，2026-10-10）。
const port = Number(/local-(\d+)\.token$/.exec(tokenFile)?.[1]);
if (!Number.isInteger(port)) {
  console.error(`令牌文件名认不出端口：${tokenFile}（该是 <家>/.mirasim/run/local-<端口>.token）`);
  process.exit(2);
}

type Verdict = '过' | '没过' | '没查成';
const results: { name: string; verdict: Verdict; evidence: string }[] = [];
const add = (name: string, verdict: Verdict, evidence: string) => results.push({ name, verdict, evidence });

const root = mkdtempSync(join(tmpdir(), 'fleet-subagents-e2e-'));
console.log(`临时目录：${root}`);
const git = (cwd: string, ...args: string[]) => runChildOk('git', args, { cwd, encoding: 'utf8' });

/** 去掉末尾 [1m] 一类上下文窗口标记，和 mirasim/run.ts 的 modelMatches 同一个口径。 */
const stripModel = (m: string) =>
  m
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '');

/** 三个角色和各自该用的模型（agents/subagents/ 下同名定义，决定 0087）。 */
const ROLES: Record<string, string> = {
  Explore: 'claude-haiku-5-5',
  'general-purpose': 'claude-sonnet-5-5',
  Plan: 'claude-opus-5-5',
};

try {
  // 1. 临时仓：拷入子代理定义，写和引擎一致的 settings.local.json
  const tree = join(root, 'tree');
  const agentsDir = join(tree, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const names: string[] = [];
  const isolated: string[] = [];
  const sourceDir = join(agentsSource, 'agents', 'subagents');
  for (const f of readdirSync(sourceDir).filter((n) => n.endsWith('.md'))) {
    copyFileSync(join(sourceDir, f), join(agentsDir, f));
    const text = readFileSync(join(sourceDir, f), 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const name = /^name:\s*(\S+)/m.exec(front)?.[1] ?? f.replace(/\.md$/, '');
    names.push(name);
    if (/^isolation:\s*\S+/m.test(front)) isolated.push(name);
  }
  // 两边要一致：这份输出必须和 packages/engine/src/real/segment-settings.ts 的 mergeLocalSettings（不带已有文件）一样——
  // env 给并发上限，permissions.deny 逐个列 Agent(<带 isolation 的名字>)（主会话是 Claude 模型）。
  // 不直接 import 引擎的模块：adapters 的测试不依赖 engine（engine 依赖 adapters）。改那边要同步改这里。
  const settings = {
    env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: MAX_CONCURRENT_SUBAGENTS },
    permissions: { deny: isolated.map((n) => `Agent(${n})`) },
  };
  writeFileSync(join(tree, '.claude', 'settings.local.json'), `${JSON.stringify(settings, null, 2)}\n`);
  writeFileSync(join(tree, '.gitignore'), '.claude/settings.local.json\n');
  git(root, 'init', '-q', '-b', 'main', tree);
  git(tree, 'config', 'user.name', 'fleet-e2e');
  git(tree, 'config', 'user.email', 'fleet-e2e');
  writeFileSync(join(tree, 'notes.md'), '# notes\n');
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', 'init');
  console.log(`子代理 ${names.length} 个，带 isolation 的：${isolated.join('、') || '无'}`);
  const missingRoles = Object.keys(ROLES).filter((n) => !names.includes(n));
  if (missingRoles.length) console.log(`提示：来源目录里缺 ${missingRoles.join('、')}，那几行会没过`);

  // 2. 一次会话
  const PROMPT = [
    '这是一次子代理验收，不读文件、不改任何东西。请依次用 Agent 工具派下面三个子代理（subagent_type 照写，不传 model），每个都只让它回一行自己的模型 id、不调任何工具：',
    '1. Explore  2. general-purpose  3. Plan',
    '最后把每个子代理的回话各一行列出，格式「<子代理名>: <回话>」，共三行。',
  ].join('\n');
  const events: ProgressEvent[] = [];
  const connect = mirasimConnector({ port, tokenFile });
  const runId = `e2e-subagents-${randomUUID().slice(0, 8)}`;
  const report = await runMirasim(
    {
      runId,
      cwd: tree,
      prompt: PROMPT,
      agent: 'claude',
      route: 'cloud',
      expectModel: mainModel,
      model: mainModel,
      session: { mode: 'new' },
      limits: { wallClockMs: 10 * 60_000, idleMs: 5 * 60_000 },
    },
    { connect, onEvent: (e) => void events.push(e), ledgerDir },
  );
  const answer = events
    .filter((e) => e.kind === 'say')
    .map((e) => String((e.payload as { text?: string }).text ?? ''))
    .join('\n');
  const answerHead = answer.slice(0, 1500);
  console.log(
    JSON.stringify(
      {
        sessionKey: report.sessionKey,
        launchError: report.launchError,
        killed: report.killed,
        stop: report.stop,
        watchError: report.watchError,
        terminal: report.terminal,
        snapshotModel: report.session.state.model,
        routing: mirasimRouting(report) ?? report.ledger,
        wallMs: report.wallMs,
      },
      null,
      2,
    ),
  );

  // 3a. 账本里的模型
  const ledger = report.ledger;
  if (!ledger) {
    add('账本里 haiku、sonnet、opus 三档都出现', '没查成', '没读到账本（没给账本目录或会话没起来）');
  } else if (ledger.state === 'unknown') {
    add('账本里 haiku、sonnet、opus 三档都出现', '没查成', `账本没读成：${ledger.detail}`);
  } else {
    // 只数真正的计费调用：去掉 count_tokens、models 这类辅助请求
    const rows = ledger.rows.filter((r) => {
      const p = r.path?.split('?')[0] ?? '';
      return !p.endsWith('/messages/count_tokens') && !p.endsWith('/v1/models');
    });
    const counts = new Map<string, number>();
    for (const r of rows) {
      const m = r.model ? stripModel(r.model) : '(无模型)';
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    const want = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
    const missing = want.filter((m) => !counts.has(m));
    const evidence = `账本共 ${ledger.rows.length} 行（计费调用 ${rows.length} 行，无法解析 ${ledger.unparsed} 行）；每个模型：${
      [...counts].map(([m, n]) => `${m}=${n}`).join('、') || '无'
    }`;
    if (rows.length === 0 || ledger.unparsed > 0) {
      add('账本里 haiku、sonnet、opus 三档都出现', '没查成', `${evidence}（没有计费调用，或有认不出的行）`);
    } else {
      add(
        '账本里 haiku、sonnet、opus 三档都出现',
        missing.length === 0 ? '过' : '没过',
        missing.length ? `${evidence}；缺：${missing.join('、')}` : evidence,
      );
    }
  }

  // 3b. 三个角色各一行，回的模型 id 对档
  const lines = answer.split('\n');
  for (const [role, want] of Object.entries(ROLES)) {
    const name = `${role} 回 ${want}`;
    // general-purpose 里没有别的角色名当子串，Explore、Plan 按词认
    const row = lines.find((l) => new RegExp(`(^|[^\\w-])${role}([^\\w-]|$)`).test(l));
    if (!answer.trim()) add(name, '没查成', '没有收到最终回答');
    else if (!row) add(name, '没查成', `最终回答里没有 ${role} 那一行`);
    else add(name, row.toLowerCase().includes(want) ? '过' : '没过', `那一行：${row}`);
  }

  // 3c. 会话结局
  const summary = mirasimRunSummary(report);
  const verdict = judgeRun(summary.facts);
  const verdictText = `outcome=${verdict.outcome} reason=${verdict.reason}`;
  if (report.killed?.reason === 'model_mismatch') {
    add('会话结局成功', '没过', `${verdictText}；被模型核对叫停，见下一条`);
  } else if (report.launchError || report.watchError || !report.terminal) {
    add(
      '会话结局成功',
      '没查成',
      `${verdictText}；launchError=${report.launchError} watchError=${report.watchError}`,
    );
  } else {
    add('会话结局成功', verdict.outcome === 'ok' ? '过' : '没过', verdictText);
  }

  // 3d. 快照模型一直是主会话的模型
  const observed = report.session.state.model;
  if (report.killed?.reason === 'model_mismatch') {
    add(
      '快照里的模型全程是主会话的模型',
      '没过',
      `被 runMirasim 的模型核对叫停：点名 ${mainModel}，读回 ${observed}（子代理跑的时候快照模型被换了，要改成只核第一次读到的）`,
    );
  } else if (!observed) {
    add('快照里的模型全程是主会话的模型', '没查成', '快照里没读到模型');
  } else {
    add(
      '快照里的模型全程是主会话的模型',
      stripModel(observed) === stripModel(mainModel) ? '过' : '没过',
      `没被叫停；最后读到 ${observed}`,
    );
  }

  console.log(`最终回答前 1500 字：\n${answerHead}`);
} catch (error) {
  add('脚本自己跑完', '没查成', error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  rmSync(root, { recursive: true, force: true });
  console.log(`临时目录已删：${root}`);
}

for (const r of results) console.log(`[${r.verdict}] ${r.name}\n    证据：${r.evidence}`);
const failed = results.filter((r) => r.verdict === '没过');
const unknown = results.filter((r) => r.verdict === '没查成');
if (failed.length) console.log(`FAIL：${failed.map((r) => r.name).join('、')}`);
else if (unknown.length) console.log(`UNKNOWN：${unknown.map((r) => r.name).join('、')}`);
else console.log('PASS');
process.exitCode = failed.length ? 1 : unknown.length ? 2 : 0;
