// second-opinion.mjs 拆出来的：审 PR 前后在 GitHub 和本机检出上的事——取 PR、切审查树、给审的人的题面；
// 审完贴评论（贴前过卫生检查）、写提交状态 second-opinion、数这个 PR 审过几轮。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { directEnv, errText, gh, isObjectLike, messageOf, NotChecked, RUNS, sh } from './so-common.mjs';
import { runSession } from './so-sessions.mjs';
import { clip, judgementLines, postedOnHead, priorRounds } from './so-verdict.mjs';
import { findBin } from './tools.mjs';

/** @typedef {import('./so-common.mjs').GhRun} GhRun */
/** @typedef {import('./so-common.mjs').SessionOpts} SessionOpts */
/** @typedef {import('./so-common.mjs').SessionResult} SessionResult */
/** @typedef {import('./so-verdict.mjs').Judgement} Judgement */
/** @typedef {import('./so-verdict.mjs').PostedVerdict} PostedVerdict */
/** @typedef {{ context?: unknown, state?: unknown, description?: unknown }} StatusRow GitHub 提交状态的一条 */
/** @typedef {{ scanFiles: (files: string[], read: (file: string) => Buffer) => { binary: unknown[], scanned: unknown[], findings: unknown[] }, formatFinding: (finding: unknown) => string }} HygieneScan 仓里卫生检查（packages/hygiene/src/scan.ts）用到的两个导出 */
/** @typedef {{ headRefOid: string, baseRefName: string, title: string, body?: string | null, files?: { path: string }[], state: string, mergeCommit?: { oid?: unknown } | null }} PrInfo gh pr view --json 里用到的那几个字段 */
/** @typedef {Omit<PrInfo, 'mergeCommit'> & { head: string, tree: string, merged: boolean, mergeCommit: string | null }} PreparedPr 审查树切好之后的 PR */
/** @typedef {{ head: string, baseRefName: string, title: string, body?: string | null | undefined, files?: { path: string }[] | undefined, merged?: boolean | undefined, mergeCommit?: string | null | undefined }} PromptInfo */
/** @typedef {{ gh: GhRun, session: (opts: SessionOpts) => Promise<SessionResult>, runs: string }} ReviewDeps 审 PR 要的几样（测试换成假的） */

// ---------- PR ----------

/**
 * 审 PR 要的几样（测试换成假的）：gh、起会话、记录和锁放哪。这台没装 gh、git 在这儿报。
 * @param {string} repo
 * @returns {ReviewDeps}
 */
export function reviewDeps(repo) {
  /** @type {[string, string][]} */
  const needed = [
    ['gh', '取 PR 的信息、贴结论'],
    ['git', '取 PR 的头、切审查树'],
  ];
  for (const [bin, forWhat] of needed) {
    if (!findBin(bin)) throw new NotChecked(`这台机器没装 ${bin}（PATH 上找不到；审 PR 要它${forWhat}）`);
  }
  return { gh: (a) => gh(a, repo), session: runSession, runs: RUNS };
}

/**
 * 主检出的根：`git worktree list` 的第一条永远是主检出（子树的注册表都挂在它下面）。
 * 从主检出里跑就是它自己；从某棵工作树里跑，认出来的也是主检出——审查树按这个根建，不往工作树里套。
 * @param {string} repo
 * @returns {string}
 */
export function mainCheckout(repo) {
  const listed = sh('git', ['worktree', 'list', '--porcelain'], repo);
  const first = listed.split('\n').find((l) => l.startsWith('worktree '));
  if (!first) throw new NotChecked('认不出主检出在哪：git worktree list 没给出一条');
  return resolve(first.slice('worktree '.length).trim());
}

/**
 * @param {string} repo
 * @param {number} pr
 * @param {number} slot
 * @param {GhRun} ghRun
 * @returns {PreparedPr}
 */
export function preparePr(repo, pr, slot, ghRun) {
  /** @type {PrInfo} */
  const info = JSON.parse(
    ghRun(['pr', 'view', String(pr), '--json', 'headRefOid,baseRefName,title,body,files,state,mergeCommit']),
  );
  if (info.state === 'CLOSED') throw new NotChecked(`PR #${pr} 关掉了、没合并：不审`);
  // 已经合进主线的照样审（合并后补审）：refs/pull/<号>/head 还在，三个点的 diff 照样只给它自己的改动
  const merged = info.state === 'MERGED';
  const mergeCommit = typeof info.mergeCommit?.oid === 'string' ? info.mergeCommit.oid : null;
  if (merged && !mergeCommit) throw new NotChecked(`PR #${pr} 说已合并，却读不到合并提交`);
  const refs = [
    'fetch',
    '-q',
    'origin',
    info.baseRefName,
    `+refs/pull/${pr}/head:refs/remotes/origin/pr/${pr}`,
  ];
  // 本机代理对 github.com 的 TLS 时好时坏（2026-09-25 实测直连通、代理不通）：先照常取，不行再绕开代理直连。
  const tries = [
    () => sh('git', refs, repo),
    () => sh('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', ...refs], repo, directEnv()),
  ];
  /** @type {string[]} */
  const errors = [];
  for (const t of tries) {
    try {
      t();
      errors.length = 0;
      break;
    } catch (e) {
      errors.push(String((isObjectLike(e) ? e.stderr : undefined) ?? messageOf(e)).trim());
    }
  }
  if (errors.length) throw new NotChecked(`git fetch 没成：${errors.join('；')}`);
  const got = sh('git', ['rev-parse', `refs/remotes/origin/pr/${pr}`], repo);
  if (got !== info.headRefOid)
    throw new NotChecked(`取回的头 ${got.slice(0, 7)} 和 PR 现在的头 ${info.headRefOid.slice(0, 7)} 对不上`);
  // 固定一棵树轮着用：Mirasim 把 codex 进程按工作目录留在池里，那个目录删不掉（Windows 报占用）。
  // 每轮切到这次的头、清掉上一轮的改动；node_modules 留着，下一轮装得快。
  //
  // 树一律建在**主检出**的 .claude/worktrees/ 下，不建在当前检出：从一棵工作树里调这个脚本（指挥官一边派工、
  // 一边审 PR 是常事）时，按当前检出算会套出一棵 `…/820-env-page/.claude/worktrees/second-opinion` 的嵌套检出
  // —— 它带着自己那份 biome.json，biome 整仓扫一遍报「nested root configuration」，把**这台机器上所有会话**
  // 的推送全拦了；而清扫规则又按名字跳过 `second-opinion*`，谁也收不走它。2026-10-05 实测攒出两棵这种嵌套树。
  const tree = join(
    mainCheckout(repo),
    '.claude',
    'worktrees',
    slot === 1 ? 'second-opinion' : `second-opinion-${slot}`,
  );
  if (!existsSync(tree)) sh('git', ['worktree', 'add', '-q', '--detach', tree, got], repo);
  else {
    sh('git', ['-C', tree, 'checkout', '-q', '--force', '--detach', got], repo);
    sh('git', ['-C', tree, 'clean', '-q', '-fdx', '-e', 'node_modules'], repo);
  }
  const at = sh('git', ['-C', tree, 'rev-parse', 'HEAD'], repo);
  if (at !== got) throw new NotChecked(`审查树停在 ${at.slice(0, 7)}，不是要审的 ${got.slice(0, 7)}`);
  return { ...info, head: got, tree, merged, mergeCommit };
}

/**
 * 给审的人的题面。挡不挡由脚本按标签判（parseReview / judgeReview），所以每条必须改的两个标签是题面里的硬要求。
 * @param {number} pr
 * @param {PromptInfo} info
 * @param {boolean} ui
 * @param {boolean} fast
 */
export function reviewPrompt(pr, info, ui, fast) {
  const files = (info.files ?? []).map((f) => f.path);
  return [
    `你是 PR #${pr} 的「第二意见」：一个全新会话，独立判断。写这段改动的是另一家模型，你的用处是找出它自己看不出的问题。`,
    '',
    `工作目录就是这个 PR 的头（${info.head}），基线是 origin/${info.baseRefName}。改动：\`git diff origin/${info.baseRefName}...HEAD\`（共 ${files.length} 个文件）。`,
    ...(info.merged
      ? [
          `这个 PR 已经合进主线（合并提交 ${String(info.mergeCommit).slice(0, 7)}），这是合并后补审：标准和合并前一样；三个点的 diff 照样只给它自己的改动。`,
        ]
      : []),
    `PR 标题：${info.title}`,
    'PR 正文（要做什么、怎么算做完、对应的 specs 都在这里）：',
    '<<<',
    info.body ?? '',
    '>>>',
    '',
    '要做的：',
    '1. 读仓根 AGENTS.md（「底线」几条是硬规矩），读正文里提到的 specs/ 需求和方案。',
    fast
      ? '2. 只看改动（git diff），必要时读改动附近的代码；不装依赖、不跑测试（CI 在同时跑）。要快：全文 600 字以内，只报最要紧的。'
      : '2. 看改动，需要时读相关代码；要跑测试先 `pnpm install --frozen-lockfile`，跑不了就照实说跑不了。',
    ui
      ? '3. 这是界面类改动：重点看界面在各种数据和失败状态下显示得对不对、说法是不是说人话、手机宽度下能不能用。'
      : '3. 只报真问题：会导致错误行为的、失败路径被当成「没事」的（读不到却回空、0、ok）、和需求或方案不符的、泄露密钥或内部信息到公开处的、测试没测到它声称测到的。风格偏好不报。',
    '4. 只管现实里会出的事。每条「必须改」开头必须写两个标签：',
    '   - 现实性：【现实】＝这次改动在正常使用里就会出问题，或者现在就有问题；【构造】＝要有人故意写出某种特殊写法才会出现的绕过、偏门情况。',
    '   - 类别：【碰安全】＝泄密、提权、放过失败、绕过检查、对公网开口子；【改数据库】＝删改已有数据或表结构；【其他】＝别的。',
    '   不要为「要人故意构造才出现」的情况报必须改：这类写进「小毛病」。',
    '',
    '规矩：不改文件、不提交、不推、不在 GitHub 上留言；不打印任何密钥、令牌的值。就在这一个会话里审完，不拆子代理、不做委派预检（省额度，结论也不会散在几处）。',
    '',
    '输出（简体中文）：',
    '## 必须改',
    '- 【现实】【碰安全】`文件:行` 问题；具体什么输入会得到什么错误结果；建议怎么改',
    '（这两个标签只是示例，按每条的实际情况写：第一个是【现实】或【构造】，第二个是【碰安全】【改数据库】【其他】之一；没有必须改就写「无」）',
    '## 小毛病',
    '- `文件:行` 问题；建议怎么改（不挡合并；没有就写「无」）',
    '',
    '最后一行单独写结论，只能是下面两种之一：',
    '结论：通过',
    '结论：必须改 N 条',
  ].join('\n');
}

// ---------- 贴评论、写状态 ----------

/** 贴到 PR 的正文：会话自己的过程话去掉，从「## 必须改」起照原样。 */
/**
 * 审查意见里本机目录（审查树、仓根）的绝对路径改成仓内相对路径：贴到公开仓的评论里不带本机目录（2026-09-26 #148 的补审评论带出过）。
 * @param {unknown} text
 * @param {readonly unknown[]} dirs
 */
export function stripLocalPaths(text, dirs) {
  let out = String(text);
  for (const d of dirs) {
    const norm = String(d).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!norm) continue;
    const pattern = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]');
    out = out.replace(new RegExp(`/?${pattern}[\\\\/]`, 'gi'), '');
  }
  return out;
}

/**
 * 贴到 PR 的评论。第一行的格式别改：POSTED_REVIEW 靠它数轮（「第二意见 第 N 轮」「审的头 七位」「：通过 / 必须改 N 条」）。
 * 结论是脚本的判定，不是审的人自己写的那句；审的人的原文（从「必须改」那一段起）附在后面。
 * @param {{ judged: Judgement, head: unknown, model: string, body: unknown, afterMerge?: boolean, mergeCommit?: string | null, roundNote?: string, note?: string }} opts
 */
export function prComment({
  judged,
  head,
  model,
  body,
  afterMerge = false,
  mergeCommit = null,
  roundNote = '',
  note = '',
}) {
  const who = afterMerge ? '合并后补审' : '第二意见';
  const conclusion = judged.pass ? '通过' : `必须改 ${judged.blocking.length} 条`;
  return [
    `**${who} 第 ${judged.round} 轮**（${model}；审的头 ${String(head).slice(0, 7)}）：${conclusion}`,
    '',
    ...judgementLines(judged, { afterMerge, mergeCommit, roundNote }),
    '',
    ...(note ? [`（${note}）`, ''] : []),
    '审的人原文：',
    '',
    String(body).trim(),
    '',
    afterMerge
      ? '<sub>本机第二意见垫片合并后补审（清单里标 review: after-merge 的 CI 判法先合后审，创始人 2026-10-03「1+2+3」）。没过的开修复 PR 或 revert。</sub>'
      : '<sub>本机第二意见垫片自动贴（规矩见 design 第五节）。挡不挡由脚本按标签和轮数判；小毛病和转合并后处理的不挡合并，合并后开小单。</sub>',
  ].join('\n');
}

/** 贴之前按仓里的卫生检查扫一遍：没扫成、扫出真密钥，一律抛（不贴；账号、组织编号、邮箱、IP 这类标识不算泄漏，
 * 不拦，创始人 2026-09-28 傍晚拍，specs/169-Fusion形态/需求.md）。 */
/**
 * @param {string} repo
 * @param {string} body
 */
export async function checkPublishable(repo, body) {
  /** @type {HygieneScan} */
  const scan = await import(pathToFileURL(join(repo, 'packages', 'hygiene', 'src', 'scan.ts')).href);
  const report = scan.scanFiles(['second-opinion.md'], () => Buffer.from(body, 'utf8'));
  if (report.binary.length > 0 || report.scanned.length !== 1) throw new Error('卫生检查没扫成，没贴');
  if (report.findings.length > 0)
    throw new Error(`卫生检查拦下了（${report.findings.map(scan.formatFinding).join('；')}），没贴`);
}

/**
 * @param {string} repo
 * @param {number} pr
 * @param {string} body
 * @param {GhRun} ghRun
 * @param {string} [runs]
 * @returns {Promise<string>}
 */
export async function postToPr(repo, pr, body, ghRun, runs = RUNS) {
  await checkPublishable(repo, body);
  mkdirSync(runs, { recursive: true });
  const file = join(runs, `.comment-${process.pid}.md`);
  writeFileSync(file, body);
  try {
    return ghRun([
      'api',
      '-X',
      'POST',
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      '-F',
      `body=@${file}`,
      '--jq',
      '.html_url',
    ]);
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * 这个头上现在的 second-opinion（GitHub 按新到旧排，取第一条）；没有回 undefined。读不到抛。
 * @param {GhRun} ghRun
 * @param {string} head
 * @returns {StatusRow | undefined}
 */
export function currentSecondOpinion(ghRun, head) {
  /** @type {unknown} */
  const all = JSON.parse(ghRun(['api', `repos/{owner}/{repo}/commits/${head}/statuses`]) || '[]');
  if (!Array.isArray(all)) throw new NotChecked(`${head.slice(0, 7)} 的提交状态认不出（不是列表）`);
  /** @type {unknown[]} */
  const rows = all;
  return rows.find(
    /** @returns {s is StatusRow} */
    (s) => isObjectLike(s) && s.context === 'second-opinion',
  );
}

/**
 * 在审的那个头上写提交状态 second-opinion（合并闸在「先审后合」时认它，#74）。头变了旧状态自然不算。
 * @param {GhRun} ghRun
 * @param {string} head
 * @param {{ state: string, description: string }} status
 * @param {string | undefined} [url]
 */
export function setStatus(ghRun, head, { state, description }, url) {
  // 总指挥已经在这个头上放行过（审查跑到一半时放行的），就不拿这一轮的结论盖掉它；结论照样贴在 PR 评论里
  const current = currentSecondOpinion(ghRun, head);
  if (current?.state === 'success' && String(current.description ?? '').startsWith('总指挥放行')) {
    console.error(
      `提交状态没改：${head.slice(0, 7)} 上已有总指挥放行（${current.description}），这一轮结论只贴评论`,
    );
    return;
  }
  const args = [
    'api',
    '-X',
    'POST',
    `repos/{owner}/{repo}/statuses/${head}`,
    '-f',
    `state=${state}`,
    '-f',
    'context=second-opinion',
    '-f',
    `description=${clip(description)}`,
  ];
  if (url) args.push('-f', `target_url=${url}`);
  ghRun(args);
}

/**
 * 这个 PR 之前审完、出了结论几轮：数本脚本贴过的结论评论（不管头变没变，第二意见和合并后补审都算）；给了 head 顺带找
 * 这个头上已贴的结论（reused，见 postedOnHead）。
 * 读不到回 { prior: null, why }，调用方按第 1 轮算（宁可多挡）。不数 runs 目录：那里的文件名用的是调用方给的 --round，
 * 同一个头重跑会盖掉；#701 贴了 10 次、每次都写「第 1 轮」。
 * @param {number} pr
 * @param {GhRun} ghRun
 * @param {string} [head]
 * @returns {{ prior: number | null, why: string, reused: PostedVerdict | null }}
 */
export function reviewRounds(pr, ghRun, head) {
  try {
    const out = ghRun([
      'api',
      '--paginate',
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      '--jq',
      '.[] | (.body // "") | @json',
    ]);
    /** @type {unknown[]} */
    const bodies = String(out)
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    if (bodies.some((b) => typeof b !== 'string')) throw new Error('评论正文认不出');
    return { prior: priorRounds(bodies), why: '', reused: head ? postedOnHead(bodies, head) : null };
  } catch (e) {
    return { prior: null, why: errText(e), reused: null };
  }
}
