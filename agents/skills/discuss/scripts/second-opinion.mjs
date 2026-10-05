#!/usr/bin/env node
// 第二意见垫片：经本机 Mirasim 起一个全新会话（默认 codex 的 gpt-6-luna、走 Mirasim 云端额度），审一个 PR，拿回结论；
// 或者拿一份分析去问反方（--text）。只在 VPS 引擎接活之前用，引擎的第二意见接上 Mirasim 就退役（fleet-dao#64）。
// 结论和过程存在 ~/.local/share/second-opinion/runs/（本机，不进任何仓：里面有 PR 内容；也不放技能目录，同步会把它换掉）。
// 帧协议照 fleet-dao docs/reference/adapters.md 第八节。完工判据借旧仓 windsurf-dao 的 scripts/lib/mirasim-runtime.mjs
// judgeCompletion：phase 到 done 且没有 error、没有 incomplete；走中继的还要账本里起针后有 2xx 行。
//
//   node second-opinion.mjs --pr 50 --high-risk --author-family <族[,族…]> [--repo <检出>] [--ui] [--timeout-min 15] [--stall-min 4] [--slot 2]
//     --timeout-min 是几家加起来的整轮总上限（默认 15）；一家起了会话后连续 --stall-min 分钟（默认 4）没有任何新输出就换下一家。
//     顺序 gpt（gpt-6-luna）→ grok → 其余兜底（claude、deepseek、kimi）；--text 的等待也是这一套。
//     已经合进主线的 PR 也能审（合并后补审）：认出是已合并的，评论、状态都写「合并后补审」，没过写明开修复 PR 或 git revert。
//   node second-opinion.mjs --after-merge-pending [--json] [--no-fetch] [--repo <检出>]
//     列合并后待补审的：主线上 14 天内合并、改到了清单里标 review: after-merge 的路径、PR 头上还没有通过的 second-opinion。
//   node second-opinion.mjs --after-merge-sweep --author-family <族[,族…]> [--repo <检出>]：把上面还没补审的逐个审一遍。
//   node second-opinion.mjs --after-merge-resolve <原 PR 号> --by <修复或 revert 的 PR 号>：补审没过、修复已合，记成已处理。
//   node second-opinion.mjs --text 分析.md --author-family <族[,族…]> [--name 短名] [--budget-sec 秒，不给就是 --timeout-min 那一套]
//     拍板前的反方：按 GPT→Grok→Claude→DeepSeek→Kimi 选不同族，退出码 0 同意 / 1 有异议 / 2 没查成
//   node second-opinion.mjs --selftest [--repo <检出>]
//   --repo 不给就用当前目录所在的 git 检出。
//
// 挡不挡由本脚本判，不信审的人最后那句「结论」（创始人 2026-10-03 晚「1+2+3」的第 2 条，规矩钉在
// agents/test/rules/second-opinion-verdict.rules.test.ts）：每条必须改带【现实】/【构造】和【碰安全】/【改数据库】/【其他】；
// 【构造】的不挡；第 1、2 轮【现实】的都挡（没带标签的按【现实】【其他】算）；第 3 轮起只挡【现实】且碰安全或改数据库的，
// 其余写通过、评论里列「转合并后处理」。第几轮 = 这个 PR 上本脚本已经贴过的结论评论数 + 1（不管头变没变）；读不到按第 1 轮算。
// 同一个头只审一次：头上已有本脚本贴的结论就复用那次的结论和退出码，不起会话、不贴评论（见 postedOnHead），
// 所以每个头最多一条结论评论，轮数就是审过的不同头的个数（#1003 同一个头隔 42 秒审两轮、轮数被推到第 3 轮）。
//
// 退出码：0 通过；1 必须改；2 没查成；3 PR 审查没开（不带 --high-risk）。连不上、没起来、超时、结果格式认不出（没有「必须改」
// 那一段、最后一行不是结论）、账本对不上、有调用没走中继，一律 2，不当通过。端点没装、没开、未登录、roster 不含模型或超时都
// 换下一家；几家都用不了照实报。
//
// 拆成同目录几份（同步工具把整个技能目录原样装到各台机器，同目录可以互引）：so-common.mjs 共用的底子（没查成、起 git/gh、
// 绕开代理）、so-profiles.mjs 各家档案和换家、so-verdict.mjs 纯判定、so-sessions.mjs 起会话（Mirasim、reclaude、cursor-agent）、
// so-pr.mjs 取 PR / 题面 / 贴评论 / 写状态、so-after-merge.mjs 合并后补审。这份是入口：反方、锁、审 PR 的整条路、命令行。
// 原来从这份 import 的名字（测试、rules 测试）照旧从这份导出，一个不多一个不少。

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AFTER_MERGE_DAYS,
  afterMergeHits,
  afterMergeResolve,
  classifyAfterMerge,
  fetchMain,
  formatPending,
  parseNameStatusLog,
  pendingAfterMerge,
  prsOfCommitsQuery,
  RISK_PATHS_FILE,
  realDeps,
  riskRules,
} from './so-after-merge.mjs';
import {
  DEFAULT_STALL_MIN,
  DEFAULT_TIMEOUT_MIN,
  errCode,
  errText,
  isObjectLike,
  messageOf,
  NotChecked,
  RUNS,
  sh,
} from './so-common.mjs';
import {
  checkPublishable,
  currentSecondOpinion,
  mainCheckout,
  postToPr,
  prComment,
  preparePr,
  reviewDeps,
  reviewPrompt,
  reviewRounds,
  setStatus,
  stripLocalPaths,
} from './so-pr.mjs';
import {
  discussionProfiles,
  FAMILY_ORDER,
  PROFILES,
  prProfiles,
  UNAVAILABLE,
  withFallback,
} from './so-profiles.mjs';
import {
  listSessions,
  OUR_SESSION_TITLE,
  parseReclaudeOutput,
  runSession,
  setKeepSession,
  stopStale,
} from './so-sessions.mjs';
import {
  ALWAYS_BLOCK,
  itemsOf,
  judgeLedger,
  judgementLines,
  judgeReview,
  judgeSnapshot,
  labelsOf,
  POSTED_REVIEW,
  parseCritique,
  parseReview,
  parseVerdict,
  postedOnHead,
  priorRounds,
  STRICT_ROUNDS,
  statusText,
} from './so-verdict.mjs';
import { findBin, NotInstalled } from './tools.mjs';
import { missingWalkthrough } from './walkthrough.mjs';

/** @typedef {import('./so-common.mjs').Options} Options */
/** @typedef {import('./so-common.mjs').Log} Log */
/** @typedef {import('./so-common.mjs').Profile} Profile */
/** @typedef {import('./so-pr.mjs').ReviewDeps} ReviewDeps */
/** @typedef {import('./so-verdict.mjs').PostedVerdict} PostedVerdict */
/** @typedef {{ dir?: string | undefined, pid?: number, alive?: (pid: number) => boolean }} LockOptions 只给测试换 */

// ask.mjs 也要用（两边起 cursor-agent 都要摘同几个环境变量）：定义挪去了 tools.mjs 共用，这里转手导出，
// 别让已经 import { cursorAgentEnv } from './second-opinion.mjs' 的调用方（包括测试）断掉。
export { cursorAgentEnv } from './tools.mjs';
export {
  AFTER_MERGE_DAYS,
  ALWAYS_BLOCK,
  afterMergeHits,
  afterMergeResolve,
  checkPublishable,
  classifyAfterMerge,
  discussionProfiles,
  FAMILY_ORDER,
  formatPending,
  itemsOf,
  judgeLedger,
  judgementLines,
  judgeReview,
  judgeSnapshot,
  labelsOf,
  mainCheckout,
  POSTED_REVIEW,
  parseCritique,
  parseNameStatusLog,
  parseReclaudeOutput,
  parseReview,
  parseVerdict,
  pendingAfterMerge,
  postedOnHead,
  prComment,
  priorRounds,
  prsOfCommitsQuery,
  RISK_PATHS_FILE,
  reviewPrompt,
  reviewRounds,
  riskRules,
  STRICT_ROUNDS,
  statusText,
  stripLocalPaths,
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
 * --text 整轮预算（秒）：没给 --budget-sec 就和 --pr 一样看 --timeout-min（默认 15 分钟）。原来 --text 单独把
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
 * 要审的仓：--repo 给了用它，没给用当前目录所在的 git 检出
 * @param {Options} o
 */
function repoOf(o) {
  if (o.repo) return resolve(o.repo);
  try {
    return resolve(sh('git', ['rev-parse', '--show-toplevel'], process.cwd()));
  } catch {
    throw new NotChecked('认不出要审的是哪个仓：在仓的检出里跑，或者用 --repo <检出> 指明');
  }
}

// ---------- 锁：同一个 PR 同时只跑一轮，不同 PR 可以并行（创始人 2026-10-03 晚：原来一把全局锁，不同 PR 也互相排队） ----------

/**
 * 拿着锁的那个进程还在不在（没权限发信号也算在）。
 * @param {number} pid
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
}

/**
 * 拿一把锁（文件 <dir>/.lock-<name>，里面是进程号）：拿着的进程还活着就抛 NotChecked；进程已死的陈旧锁直接盖掉。
 * 返回放锁的函数；进程退出时也放。dir / pid / alive 只给测试换。
 * @param {string} name
 * @param {string} why
 * @param {LockOptions} [opts]
 * @returns {() => void}
 */
export function takeLock(name, why, { dir = RUNS, pid = process.pid, alive = isAlive } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `.lock-${name}`);
  if (existsSync(file)) {
    const holder = Number(readFileSync(file, 'utf8'));
    if (holder !== pid && alive(holder)) throw new NotChecked(`${why}（进程 ${holder}），等它跑完`);
  }
  writeFileSync(file, String(pid));
  const release = () => {
    process.off('exit', release);
    rmSync(file, { force: true });
  };
  process.on('exit', release);
  return release;
}

/**
 * 每个位子一棵审查树（固定几棵轮着用，见 preparePr）：没指定 --slot 就挑第一个空着的；都被占着照实报。
 * @param {{ slotGiven?: boolean | undefined, slot: number }} o
 * @param {LockOptions} [deps]
 * @returns {{ slot: number, release: () => void }}
 */
export function takeSlot(o, deps = {}) {
  if (o.slotGiven && (!Number.isInteger(o.slot) || o.slot < 1 || o.slot > 4))
    throw new NotChecked('--slot 只能是 1–4');
  /** @type {string[]} */
  const busy = [];
  for (const slot of o.slotGiven ? [o.slot] : [1, 2, 3, 4]) {
    try {
      return { slot, release: takeLock(`slot${slot}`, `审查树 ${slot} 另一轮在用`, deps) };
    } catch (e) {
      if (!(e instanceof NotChecked)) throw e;
      busy.push(e.message);
    }
  }
  // 指定了位子就只试过它一个，busy 里只有一条，join 出来就是那一条
  throw new NotChecked(o.slotGiven ? busy.join('；') : `四棵审查树都有人在用：${busy.join('；')}`);
}

/**
 * 审一个 PR（开着的、已经合并的都行）：起会话、按标签和轮数判、贴评论、写提交状态。
 * 返回退出码：0 通过、1 必须改、2 没查成（结果格式认不出、状态没写上）；起会话这类没查成抛 NotChecked。
 * @param {{ o: Options, repo: string, pr: number, log: Log, deps?: ReviewDeps }} opts
 * @returns {Promise<number>}
 */
export async function reviewPr({ o, repo, pr, log, deps = reviewDeps(repo) }) {
  const chain = prProfiles(o); // 作者族不对先在这儿报，别等树切好了才说
  // 同一个 PR 同时只跑一轮（后来的退出 2）；不同 PR 各拿各的审查树，可以并行
  const releasePr = takeLock(`pr${pr}`, `PR #${pr} 另一轮第二意见在跑`, { dir: deps.runs });
  const { slot, release: releaseSlot } = takeSlot(o, { dir: deps.runs });
  try {
    return await reviewPrLocked({ o, repo, pr, log, chain, slot, deps });
  } finally {
    releaseSlot();
    releasePr();
  }
}

/**
 * @param {{ o: Options, repo: string, pr: number, log: Log, chain: Profile[], slot: number, deps: ReviewDeps }} opts
 * @returns {Promise<number>}
 */
async function reviewPrLocked({ o, repo, pr, log, chain, slot, deps }) {
  const info = preparePr(repo, pr, slot, deps.gh);
  const counted = reviewRounds(pr, deps.gh, info.head);
  if (counted.reused) return reuseVerdict({ o, pr, head: info.head, reused: counted.reused, log, deps });
  const round = (counted.prior ?? 0) + 1;
  const roundNote =
    counted.prior === null
      ? `轮数没数成（读不到 PR 上已有的评论：${counted.why}），按第 1 轮算（宁可多挡）`
      : `这个 PR 之前审完过 ${counted.prior} 轮，这是第 ${round} 轮`;
  const afterMerge = info.merged;
  const who = afterMerge ? '合并后补审' : '第二意见';
  mkdirSync(deps.runs, { recursive: true });
  const out = join(deps.runs, `pr${pr}-${info.head.slice(0, 7)}-r${round}.md`);
  log(
    `PR #${pr} 头 ${info.head.slice(0, 7)}${afterMerge ? `（已合并，合并提交 ${String(info.mergeCommit).slice(0, 7)}：合并后补审）` : ''}，工作树 ${info.tree}；${roundNote}`,
  );
  try {
    // 默认快：中等思考强度、只看 diff、不跑测试，和 CI 同时跑（创始人 2026-09-25 定的关卡时间预算）；--slow 才走老的完整审法
    const fast = !o.slow;
    // 整轮总上限：--timeout-min（默认 15 分钟）是几家加起来的，不是每家各给一份；每家再按「不出声就换」（stallMin）自己换下一家
    const r = await withFallback(
      chain,
      log,
      (p, remainingMs) =>
        deps.session({
          prompt: reviewPrompt(pr, info, o.ui, fast),
          profile: p,
          workdir: info.tree,
          timeoutMin: Math.min(o.timeoutMin, (remainingMs ?? o.timeoutMin * 60_000) / 60_000),
          log,
          pollMs: fast ? 2_000 : 10_000,
          stallMin: o.stallMin ?? DEFAULT_STALL_MIN,
          effort: o.effort ?? (fast ? 'medium' : undefined),
        }),
      { budgetMs: o.timeoutMin * 60_000 },
    );
    r.text = stripLocalPaths(r.text, [info.tree, repo]);
    const model = r.model ?? r.profile.model ?? r.profile.agent;
    const head = [
      `# PR #${pr} ${who} 第 ${round} 轮`,
      '',
      `- 审的头：${info.head}`,
      ...(afterMerge ? [`- 已合并：合并提交 ${info.mergeCommit}`] : []),
      `- 会话：${r.sessionKey}（${model}）${r.fallbackNote ? `；${r.fallbackNote}` : ''}`,
      `- 账本：${r.ledgerNote}；${r.usage}`,
      `- 轮数：${roundNote}`,
    ];
    const parsed = parseReview(r.text);
    if (!parsed.ok) {
      // 认不出的不贴、不写状态：不当通过，也不拿一份读不懂的东西去挡人
      writeFileSync(
        out,
        [...head, `- 结论：认不出（没查成，不算通过）：${parsed.why}`, '', '---', '', r.text, ''].join('\n'),
      );
      console.log(out);
      log(`没查成：审的结果${parsed.why}`);
      return 2;
    }
    const judged = judgeReview(parsed, round);
    const status = statusText(judged, afterMerge);
    writeFileSync(
      out,
      [
        ...head,
        `- 结论：${status.description}`,
        '',
        ...judgementLines(judged, { afterMerge, mergeCommit: info.mergeCommit, roundNote }),
        '',
        '---',
        '',
        r.text,
        '',
      ].join('\n'),
    );
    console.log(out);
    let code = judged.pass ? 0 : 1;
    if (!o.noPost) {
      let url;
      try {
        url = await postToPr(
          repo,
          pr,
          prComment({
            judged,
            head: info.head,
            model,
            body: parsed.body,
            afterMerge,
            mergeCommit: info.mergeCommit,
            roundNote,
            note: r.fallbackNote ?? '',
          }),
          deps.gh,
          deps.runs,
        );
        log(`贴到了 PR：${url}`);
      } catch (e) {
        log(`没贴上 PR：${messageOf(e)}`);
        appendFileSync(out, `\n（没贴上 PR：${messageOf(e)}）\n`);
      }
      try {
        setStatus(deps.gh, info.head, status, url);
        log(
          `提交状态 second-opinion 写到了 ${info.head.slice(0, 7)}：${status.state}（${status.description}）`,
        );
      } catch (e) {
        log(`提交状态没写上：${errText(e)}`);
        code = 2;
      }
    }
    if (afterMerge && !judged.pass)
      console.log(
        `合并后补审没过：开修复 PR，或 git revert ${String(info.mergeCommit).slice(0, 7)}；修复合了跑 --after-merge-resolve ${pr} --by <修复 PR 号>`,
      );
    return code;
  } catch (e) {
    writeFileSync(
      out,
      `# PR #${pr} ${who} 第 ${round} 轮：没查成\n\n- 审的头：${info.head}\n- 原因：${messageOf(e)}\n`,
    );
    console.log(out);
    throw e;
  }
}

/**
 * 同一个头上已经贴过本脚本的结论：不起会话、不贴评论、不加轮数，照那次的结论退出（通过 0、必须改 1）。
 * 头上的提交状态和那次结论对不上（上次评论贴上了、状态没写上）就照那次结论补写；读不到、写不上退出 2，不当通过。
 * @param {{ o: Options, pr: number, head: string, reused: PostedVerdict, log: Log, deps: ReviewDeps }} opts
 * @returns {number}
 */
function reuseVerdict({ o, pr, head, reused, log, deps }) {
  const code = reused.pass ? 0 : 1;
  const short = head.slice(0, 7);
  log(
    `PR #${pr} 头 ${short} 上已经有本脚本贴的结论（${reused.line}）：同一个头不再审、不加轮数，照那次的结论退出 ${code}`,
  );
  if (o.noPost) return code;
  const want = reused.pass ? 'success' : 'failure';
  try {
    if (currentSecondOpinion(deps.gh, head)?.state === want) return code;
  } catch (e) {
    log(`没查成：读不到 ${short} 上的提交状态（${errText(e)}），不知道那次结论落没落到状态上`);
    return 2;
  }
  const description = reused.pass
    ? `${reused.who}通过（第 ${reused.round} 轮；照 ${short} 上已贴的结论补写）`
    : `${reused.who}第 ${reused.round} 轮：必须改 ${reused.blocking} 条（照 ${short} 上已贴的结论补写）`;
  try {
    setStatus(deps.gh, head, { state: want, description });
    log(`提交状态 second-opinion 照已贴的结论补写到了 ${short}：${want}（${description}）`);
  } catch (e) {
    log(`提交状态没写上：${errText(e)}`);
    return 2;
  }
  return code;
}

/**
 * 退出码合起来：有没查成的算 2，否则有必须改的算 1。
 * @param {number} a
 * @param {number} b
 */
const worse = (a, b) => (a === 2 || b === 2 ? 2 : Math.max(a, b));

/**
 * --after-merge-sweep：把还没补审的逐个审一遍（补审没过的不重跑，见本段开头）。
 * @param {{ o: Options, repo: string, log: Log }} opts
 * @returns {Promise<number>}
 */
async function afterMergeSweep({ o, repo, log }) {
  prProfiles(o); // 作者族先核
  const p = pendingAfterMerge({ ...realDeps(repo), fetchMain: o.noFetch ? null : () => fetchMain(repo) });
  console.log(formatPending(p));
  let code = 0;
  for (const item of p.unreviewed) {
    log(`—— 补审 #${item.number} ——`);
    try {
      code = worse(code, await reviewPr({ o, repo, pr: item.number, log }));
    } catch (e) {
      log(`#${item.number} 没查成：${messageOf(e)}`);
      code = 2;
    }
  }
  return code;
}

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function args(argv) {
  /** @type {Options} */
  const o = { timeoutMin: DEFAULT_TIMEOUT_MIN, stallMin: DEFAULT_STALL_MIN, ui: false, slot: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') o.pr = Number(argv[++i]);
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--round') {
      // 不再起作用：第几轮由脚本数 PR 上已经贴过的结论（#701 贴了 10 次、每次都写「第 1 轮」）
      i++;
      o.roundGiven = true;
    } else if (a === '--after-merge-pending') o.afterMergePending = true;
    else if (a === '--after-merge-sweep') o.afterMergeSweep = true;
    else if (a === '--after-merge-resolve') {
      o.resolve = Number(argv[++i]);
      o.resolveGiven = true;
    } else if (a === '--by') o.by = Number(argv[++i]);
    else if (a === '--json') o.json = true;
    else if (a === '--no-fetch') o.noFetch = true;
    else if (a === '--slot') {
      o.slot = Number(argv[++i]);
      o.slotGiven = true;
    } else if (a === '--timeout-min') o.timeoutMin = Number(argv[++i]);
    else if (a === '--stall-min') o.stallMin = Number(argv[++i]);
    else if (a === '--ui') o.ui = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--ping') o.ping = true;
    else if (a === '--no-post') o.noPost = true;
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
    else if (a === '--slow') o.slow = true;
    else if (a === '--high-risk') o.highRisk = true;
    else if (a === '--post-merge') o.postMerge = true;
    else throw new NotChecked(`不认识的参数 ${a}`);
  }
  return o;
}

/** @param {string} repo */
async function selftest(repo) {
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
  // 挡不挡由脚本判（规矩钉在 agents/test/rules/second-opinion-verdict.rules.test.ts，这里只抽几条）
  /**
   * @param {string} text
   * @param {number} round
   */
  const judged = (text, round) => {
    const p = parseReview(text);
    return p.ok ? judgeReview(p, round).pass : null;
  };
  eq(judged('## 必须改\n- `a.ts:1` 没带标签\n结论：必须改 1 条', 1), false, '没带标签的照挡');
  eq(judged('## 必须改\n- 【构造】【碰安全】`a.ts:1` 偏门写法\n结论：必须改 1 条', 1), true, '构造的不挡');
  eq(
    judged('## 必须改\n- 【现实】【其他】`a.ts:1` 问题\n结论：必须改 1 条', 3),
    true,
    '第 3 轮其他的转合并后',
  );
  eq(
    judged('## 必须改\n- 【现实】【碰安全】`a.ts:1` 问题\n结论：必须改 1 条', 3),
    false,
    '第 3 轮碰安全照挡',
  );
  eq(judged('## 必须改\n- 【现实】【其他】`a.ts:1` 问题\n结论：通过', 1), false, '审的人说通过也照挡');
  eq(judged('只有一句话\n结论：通过', 1), null, '没有必须改那一段认不出');
  const parsed = parseReview('我先读规矩……\n## 必须改\n- 【现实】【其他】`a.ts:1` 问题\n结论：必须改 1 条');
  if (!parsed.ok) throw new Error(`贴 PR 的样例解析不出：${parsed.why}`);
  const c = prComment({
    judged: judgeReview(parsed, 1),
    head: 'abcdef1234',
    model: 'gpt-6-luna',
    body: parsed.body,
  });
  eq(
    c.includes('我先读规矩') || !c.includes('## 必须改') || !c.includes('abcdef1'),
    false,
    '贴 PR 的正文去掉过程话、带着头',
  );
  eq(priorRounds([c, '别的评论']), 1, '贴出去的结论评论数得出轮数');
  // 卫生检查：扫出真密钥不贴、干净的放行（卫生检查的代码用 repo 里那份；账号、组织编号、邮箱、IP 这类标识不算
  // 泄漏，不拦，创始人 2026-09-28 傍晚拍，specs/169-Fusion形态/需求.md）
  const leakToken = ['ghp', 'Q3mNz8VbTf6RpLc2WdYs5HuXa9GjKe4B'].join('_');
  /** @param {Promise<unknown>} p */
  const rejects = async (p) =>
    p.then(
      () => false,
      () => true,
    );
  eq(await rejects(checkPublishable(repo, `里面有 ${leakToken} 这个值`)), true, '扫出真密钥不贴');
  eq(await rejects(checkPublishable(repo, '干净的正文')), false, '干净的放行');
  eq(parseCritique('## 漏掉的\n无\n结论：同意'), { agree: true, objections: 0 }, '反方同意');
  eq(parseCritique('**结论：有异议 3 条**'), { agree: false, objections: 3 }, '反方有异议');
  eq(parseCritique('结论：有异议 0 条'), null, '有异议 0 条认不出');
  eq(parseCritique('结论：通过'), null, '审 PR 的结论不算反方结论');
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
  console.log('selftest ok（33 条）');
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.selftest) return await selftest(repoOf(o));
  setKeepSession(o.keepSession === true);
  // 会话列表 / 清旧会话：都是本机 Mirasim 的操作，不审东西、不碰仓。
  if (o.sessions) {
    const list = await listSessions();
    if (list.length === 0) console.log('本机 Mirasim 上一个会话也没有');
    for (const s of list) {
      const ours = OUR_SESSION_TITLE.test(String(s.title ?? '')) ? '第二意见' : '别的';
      console.log(
        `${s.sessionKey}\t${s.runState ?? '?'}\t${ours}\t${(String(s.title ?? '').split('\n')[0] ?? '').slice(0, 40)}`,
      );
    }
    return;
  }
  if (o.stopStale) {
    const r = await stopStale((s) => console.log(s));
    console.log(`清掉 ${r.deleted} 个已停的第二意见会话；还有 ${r.stillRunning} 个在跑的没动`);
    return;
  }
  const profile = o.ui ? PROFILES.ui : PROFILES.code;
  if (o.ping) {
    // 走一遍整条路（起会话、判完工、核账本），不审东西。
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
  /** @type {Log} */
  const log = (s) => console.error(s);
  if (o.roundGiven) log('--round 不再起作用：第几轮由脚本数这个 PR 上已经贴过的结论评论（不管头变没变）');
  // 合并后补审：列、记成已处理都不审东西；要不要 --high-risk 不相干（清单里标 review: after-merge 的本来就是先审后合的路径）
  if (o.afterMergePending) {
    const repo = repoOf(o);
    if (!findBin('git')) throw new NotChecked('这台机器没装 git（PATH 上找不到）');
    const p = pendingAfterMerge({ ...realDeps(repo), fetchMain: o.noFetch ? null : () => fetchMain(repo) });
    console.log(o.json ? JSON.stringify(p) : formatPending(p));
    return;
  }
  if (o.resolveGiven || o.by !== undefined) {
    process.exitCode = await afterMergeResolve({ o, repo: repoOf(o), log });
    return;
  }
  // PR 审查只在先审后合的改动上跑（创始人 2026-09-26 定，design 第五节「流程只为快」）：加 --high-risk（--post-merge 是旧名字，
  // 一样算）。别的 PR 审查一律不跑，退出码 3（不是 0，免得调用方当成通过）。方案讨论（--text）不受影响。
  if (o.pr && !o.highRisk && !o.postMerge) {
    console.error(
      'PR 第二意见只在先审后合的改动（迁移里有删改语句、碰安全；清单里标先合后审的合并后补）上跑，要加 --high-risk；其余 CI 绿就合（design 第五节）。',
    );
    process.exitCode = 3;
    return;
  }
  if (o.text) return await critique({ ...o, text: o.text });
  if (o.afterMergeSweep) {
    const repo = repoOf(o);
    for (const bin of ['git', 'gh'])
      if (!findBin(bin)) throw new NotChecked(`这台机器没装 ${bin}（PATH 上找不到）`);
    process.exitCode = await afterMergeSweep({ o, repo, log });
    return;
  }
  const pr = o.pr;
  if (pr === undefined || !Number.isInteger(pr) || pr <= 0)
    throw new NotChecked('要 --pr <号>、--text <文件>，或 --after-merge-pending / --after-merge-sweep');
  process.exitCode = await reviewPr({ o, repo: repoOf(o), pr, log });
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
