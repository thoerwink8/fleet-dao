#!/usr/bin/env node
// 讨论用的「反方」：经本机 Mirasim 起一个全新会话（默认 codex 的 gpt-6-luna、走 Mirasim 云端额度），拿一份分析去问反方（--text），
// 拿回结论。只在 VPS 引擎接活之前用（讨论的一问一答另有 ask.mjs，走 cursor-agent）。
// 结论和过程存在 ~/.local/share/second-opinion/runs/（本机，不进任何仓；也不放技能目录，同步会把它换掉）。
// 帧协议照 fleet-dao docs/reference/adapters.md 第八节。完工判据借旧仓 windsurf-dao 的 scripts/lib/mirasim-runtime.mjs
// judgeCompletion：phase 到 done 且没有 error、没有 incomplete；走中继的还要账本里起针后有 2xx 行。
//
//   node second-opinion.mjs --text 分析.md --author-family <族[,族…]> [--name 短名] [--budget-sec 秒，不给就是 --timeout-min 那一套]
//     [--blind] [--agent <profile>] [--ui] [--effort medium] [--timeout-min 15] [--stall-min 4] [--keep-session]
//     拍板前的反方：按 GPT→Grok→Claude→DeepSeek→Kimi 选不同族，退出码 0 同意 / 1 有异议 / 2 没查成。
//     --timeout-min 是几家加起来的整轮总上限（默认 15）；一家起了会话后连续 --stall-min 分钟（默认 4）没有任何新输出就换下一家。
//   node second-opinion.mjs --sessions | --stop-stale：列本机 Mirasim 上的会话 / 清掉已停的反方会话。
//   node second-opinion.mjs --ping：走一遍起会话、判完工、核账本，不问东西。
//   node second-opinion.mjs --selftest
//
// 退出码：0 同意；1 有异议；2 没查成。连不上、没起来、超时、结果格式认不出（最后一行不是结论）、账本对不上、有调用没走中继，
// 一律 2，不当同意。端点没装、没开、未登录、roster 不含模型或超时都换下一家；几家都用不了照实报。
//
// 拆成同目录几份（同步工具把整个技能目录原样装到各台机器，同目录可以互引）：so-common.mjs 共用的底子（没查成、记录放哪）、
// so-profiles.mjs 各家档案和换家、so-verdict.mjs 纯判定（认结论行、判快照和账本）、so-sessions.mjs 起会话（Mirasim、reclaude、
// cursor-agent）。这份是入口：反方和命令行。从这份 import 的名字（测试）照旧从这份导出。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STALL_MIN,
  DEFAULT_TIMEOUT_MIN,
  errCode,
  isObjectLike,
  messageOf,
  NotChecked,
  RUNS,
} from './so-common.mjs';
import { discussionProfiles, FAMILY_ORDER, PROFILES, UNAVAILABLE, withFallback } from './so-profiles.mjs';
import {
  listSessions,
  OUR_SESSION_TITLE,
  parseReclaudeOutput,
  runSession,
  setKeepSession,
  stopStale,
} from './so-sessions.mjs';
import { judgeLedger, judgeSnapshot, parseCritique, parseVerdict } from './so-verdict.mjs';
import { NotInstalled } from './tools.mjs';
import { missingWalkthrough } from './walkthrough.mjs';

/** @typedef {import('./so-common.mjs').Options} Options */

// ask.mjs 也要用（两边起 cursor-agent 都要摘同几个环境变量）：定义挪去了 tools.mjs 共用，这里转手导出，
// 别让已经 import { cursorAgentEnv } from './second-opinion.mjs' 的调用方（包括测试）断掉。
export { cursorAgentEnv } from './tools.mjs';
export {
  discussionProfiles,
  FAMILY_ORDER,
  judgeLedger,
  judgeSnapshot,
  parseCritique,
  parseReclaudeOutput,
  parseVerdict,
  UNAVAILABLE,
};

// ---------- 反方（拍板前的分析） ----------

/** @param {string} question */
function blindPrompt(question) {
  return [
    '下面是一道设计题。独立给出你的方案：不知道别人怎么想，也不要迎合谁。',
    '要快、要短：全文 400 字以内，不读文件、不跑命令、不拆子代理。',
    '',
    '<<<',
    question,
    '>>>',
    '',
    '输出（简体中文，说人话）：',
    '## 方案（几条要点）',
    '## 关键取舍（你放弃了什么、为什么）',
    '## 最容易出事的地方',
  ].join('\n');
}

/** @param {string} material */
function critiquePrompt(material) {
  return [
    '你是「反方」：一个全新会话，另一家模型。下面是另一个 AI（总指挥）准备交给创始人拍板的分析和选项。',
    '你的用处是找出它自己看不出的东西——框架错在哪、漏了哪种情况、代价估错在哪、有没有更根本的问题它没碰到。',
    '不要重新设计整个系统，只针对这份分析说话；同意的地方一句带过，不凑异议。',
    '要快、要短：全文 400 字以内，只写最要紧的几条（最多 5 条），每条一两句。',
    '',
    '<<<',
    material,
    '>>>',
    '',
    '规矩：就在这一个会话里答完，不读文件、不跑命令、不拆子代理；不打印任何密钥、令牌的值。',
    '',
    '输出（简体中文，说人话）：',
    '## 框架对不对',
    '（它把问题看成什么；你认为该看成什么。一致就写「一致」）',
    '## 漏掉的',
    '- 每条：漏了什么；什么情况下会出事；建议怎么补',
    '（没有就写「无」）',
    '## 选项怎么改',
    '（给创始人的选项该加、该删、该改哪条；推荐哪个、为什么）',
    '',
    '最后一行单独写结论，只能是下面两种之一：',
    '结论：同意',
    '结论：有异议 N 条',
  ].join('\n');
}

/**
 * --text 整轮预算（秒）：没给 --budget-sec 就看 --timeout-min（默认 15 分钟）。原来 --text 单独把
 * 等待压成 0.5 分钟、预算 30 秒，gpt 一次要几分钟就被整轮掐掉（创始人 2026-10-05）。
 * @param {Pick<Options, 'timeoutMin' | 'budgetSec'>} o
 */
export function discussionBudgetSec(o) {
  return Number(o.budgetSec ?? o.timeoutMin * 60);
}

/** @param {Options & { text: string }} o */
async function critique(o) {
  const src = resolve(o.text);
  /** @type {string} */
  let material;
  try {
    material = readFileSync(src, 'utf8');
  } catch (e) {
    throw new NotChecked(`读不到 ${src}（${errCode(e) ?? messageOf(e)}）`);
  }
  if (!material.trim()) throw new NotChecked(`${src} 是空的`);
  if (!o.blind) {
    const why = missingWalkthrough(material);
    if (why) throw new NotChecked(why);
  }
  // 中性目录：不在任何仓里，会话不会自己读进 AGENTS.md 之类，只凭题面说话
  const dir = join(RUNS, 'critique');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = (o.name ?? 'critique').replace(/[^\w一-鿿-]/g, '-');
  const out = join(RUNS, `critique-${name}-${stamp}.md`);
  try {
    const chain = discussionProfiles(o);
    const budgetSec = discussionBudgetSec(o);
    if (!Number.isFinite(budgetSec) || budgetSec <= 0)
      throw new NotChecked('--budget-sec 必须是正数（不给就是 --timeout-min 那一套，默认 15 分钟）');
    const budgetMs = budgetSec * 1000;
    const r = await withFallback(
      chain,
      (s) => console.error(s),
      (p, remainingMs) =>
        runSession({
          prompt: o.blind ? blindPrompt(material) : critiquePrompt(material),
          profile: p,
          workdir: dir,
          timeoutMin: Math.min(o.timeoutMin, (remainingMs ?? o.timeoutMin * 60_000) / 60_000),
          log: (s) => console.error(s),
          pollMs: 1_000,
          stallMin: o.stallMin ?? DEFAULT_STALL_MIN,
          effort: o.effort,
          discussion: true,
        }),
      { budgetMs },
    );
    const profile = r.profile;
    const v = o.blind ? (r.text.trim() ? { agree: true, objections: 0 } : null) : parseCritique(r.text);
    const head = [
      `# ${o.blind ? '盲答' : '反方'}：${name}`,
      '',
      `- 题面：${src}`,
      `- 会话：${r.sessionKey}（${r.model ?? profile.model ?? profile.agent}，思考强度 ${o.effort ?? '默认'}）${r.fallbackNote ? `；${r.fallbackNote}` : ''}`,
      `- 账本：${r.ledgerNote}；${r.usage}`,
      `- 结论：${o.blind ? (v ? '答了' : '空的（没查成）') : v ? (v.agree ? '同意' : `有异议 ${v.objections} 条`) : '认不出（没查成）'}`,
      '',
      '---',
      '',
    ].join('\n');
    writeFileSync(out, `${head + r.text}\n`);
    console.log(out);
    process.exitCode = v ? (v.agree ? 0 : 1) : 2;
  } catch (e) {
    writeFileSync(out, `# 反方：${name}：没查成\n\n- 题面：${src}\n- 原因：${messageOf(e)}\n`);
    console.log(out);
    throw e;
  }
}

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function args(argv) {
  /** @type {Options} */
  const o = { timeoutMin: DEFAULT_TIMEOUT_MIN, stallMin: DEFAULT_STALL_MIN, ui: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout-min') o.timeoutMin = Number(argv[++i]);
    else if (a === '--stall-min') o.stallMin = Number(argv[++i]);
    else if (a === '--ui') o.ui = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--ping') o.ping = true;
    else if (a === '--keep-session') o.keepSession = true;
    else if (a === '--sessions') o.sessions = true;
    else if (a === '--stop-stale') o.stopStale = true;
    else if (a === '--text') o.text = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--effort') o.effort = argv[++i];
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '--author-family') o.authorFamily = [o.authorFamily, argv[++i]].filter(Boolean).join(',');
    else if (a === '--exclude-family') o.excludeFamily = argv[++i];
    else if (a === '--budget-sec') o.budgetSec = Number(argv[++i]);
    else if (a === '--blind') o.blind = true;
    else throw new NotChecked(`不认识的参数 ${a}`);
  }
  return o;
}

function selftest() {
  /**
   * @param {unknown} a
   * @param {unknown} b
   * @param {string} what
   */
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}：要 ${JSON.stringify(b)}，得 ${JSON.stringify(a)}`);
  };
  eq(parseVerdict('## 必须改\n无\n结论：通过'), { pass: true, blocking: 0 }, '通过');
  eq(parseVerdict('…\n**结论：必须改 2 条**\n'), { pass: false, blocking: 2 }, '必须改带加粗');
  eq(parseVerdict('结论：必须改 0 条'), null, '必须改 0 条认不出');
  eq(parseVerdict('结论：通过\n另外一句'), null, '结论不在最后一行');
  eq(parseVerdict(''), null, '空输出');
  eq(
    judgeSnapshot({ phase: 'done', error: 'pi turn stalled past 30 minutes' }).status,
    'failed',
    'done 带死因',
  );
  eq(judgeSnapshot({ phase: 'done', incomplete: true }).status, 'failed', 'done 带 incomplete');
  eq(judgeSnapshot({ phase: 'streaming' }).status, 'running', '还在跑');
  eq(judgeSnapshot({}).status, 'unknown', '没有 phase');
  eq(judgeSnapshot({ phase: 'done', error: null }).status, 'done', '真完工');
  const t0 = Date.parse('2026-09-25T10:00:00Z');
  /**
   * @param {string} ts
   * @param {number} status
   * @param {boolean} viaRelay
   * @param {string} [upstreamHost]
   */
  const row = (ts, status, viaRelay, upstreamHost = 'relay') => ({ ts, status, viaRelay, upstreamHost });
  eq(judgeLedger([row('2026-09-25T10:00:05Z', 200, true)], t0, true).ok, true, '中继成功');
  eq(judgeLedger([row('2026-09-25T09:00:00Z', 200, true)], t0, true).ok, false, '只有起针前的行');
  eq(judgeLedger([row('2026-09-25T10:00:05Z', 200, false, 'api.example')], t0, true).ok, false, '没走中继');
  eq(judgeLedger([row('2026-09-25T10:00:05Z', 429, true)], t0, true).ok, false, '只有失败行');
  eq(judgeLedger([], t0, true).ok, false, '空账本');
  eq(parseCritique('## 漏掉的\n无\n结论：同意'), { agree: true, objections: 0 }, '反方同意');
  eq(parseCritique('**结论：有异议 3 条**'), { agree: false, objections: 3 }, '反方有异议');
  eq(parseCritique('结论：有异议 0 条'), null, '有异议 0 条认不出');
  eq(parseCritique('结论：通过'), null, '「通过」不算反方结论');
  eq(
    UNAVAILABLE.test(
      '快照报 done 但带着 incomplete：Selected model is at capacity. Please try a different model.',
    ),
    true,
    '模型满载算连不上、换下一家',
  );
  eq(UNAVAILABLE.test('结论认不出'), false, '认不出结论不换人');
  eq(missingWalkthrough('【规则】只有方案没有推演') !== null, true, '反方题面缺【推演】拦下');
  eq(
    missingWalkthrough(
      `【推演】${'从开单走到关单，每个阶段的边界和最坏情况都列了，对照了成熟产品的做法。'.repeat(3)}`,
    ),
    null,
    '带够【推演】放行',
  );
  console.log('selftest ok（23 条）');
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.selftest) return selftest();
  setKeepSession(o.keepSession === true);
  // 会话列表 / 清旧会话：都是本机 Mirasim 的操作，不碰题面。
  if (o.sessions) {
    const list = await listSessions();
    if (list.length === 0) console.log('本机 Mirasim 上一个会话也没有');
    for (const s of list) {
      const ours = OUR_SESSION_TITLE.test(String(s.title ?? '')) ? '反方' : '别的';
      console.log(
        `${s.sessionKey}\t${s.runState ?? '?'}\t${ours}\t${(String(s.title ?? '').split('\n')[0] ?? '').slice(0, 40)}`,
      );
    }
    return;
  }
  if (o.stopStale) {
    const r = await stopStale((s) => console.log(s));
    console.log(`清掉 ${r.deleted} 个已停的反方会话；还有 ${r.stillRunning} 个在跑的没动`);
    return;
  }
  const profile = o.ui ? PROFILES.ui : PROFILES.code;
  if (o.ping) {
    // 走一遍整条路（起会话、判完工、核账本），不问东西。
    const dir = join(RUNS, 'ping');
    mkdirSync(dir, { recursive: true });
    const r = await runSession({
      prompt: '只回一行，原样照抄：结论：通过',
      profile,
      workdir: dir,
      timeoutMin: 10,
      log: (s) => console.error(s),
    });
    console.log(
      `${r.sessionKey}（${r.model}）｜${r.ledgerNote}｜${r.usage}｜结论 ${JSON.stringify(parseVerdict(r.text))}`,
    );
    process.exitCode = parseVerdict(r.text)?.pass ? 0 : 2;
    return;
  }
  if (o.text) return await critique({ ...o, text: o.text });
  throw new NotChecked('要 --text <文件>（反方），或 --sessions / --stop-stale / --ping / --selftest');
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

// 被测试 import 时不跑
if (isMain()) {
  main().catch((e) => {
    console.error(
      e instanceof NotChecked || e instanceof NotInstalled
        ? `没查成：${e.message}`
        : isObjectLike(e)
          ? e.stack
          : undefined,
    );
    process.exitCode = 2;
  });
}
