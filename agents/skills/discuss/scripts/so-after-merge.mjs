// second-opinion.mjs 拆出来的：合并后补审——列待补审的（--after-merge-pending）、补审没过的记成已处理（--after-merge-resolve）。
// 逐个补审（--after-merge-sweep）要调审 PR 的整条路，留在入口。
import { directEnv, errText, gh, isObjectLike, messageOf, NotChecked, sh } from './so-common.mjs';
import { currentSecondOpinion, postToPr, reviewDeps, setStatus } from './so-pr.mjs';
import { findBin } from './tools.mjs';

/** @typedef {import('./so-common.mjs').GhRun} GhRun */
/** @typedef {import('./so-common.mjs').Log} Log */
/** @typedef {import('./so-common.mjs').Options} Options */
/** @typedef {import('./so-pr.mjs').ReviewDeps} ReviewDeps */
/** @typedef {{ path: string, afterMerge: boolean }} RiskRule 高风险清单的一条：路径、是不是先合后审 */
/** @typedef {{ path: string, previous?: string }} ChangedFile 一个提交改到的文件（改名、复制带上旧名字） */
/** @typedef {{ sha: string, date: string, files: ChangedFile[] }} LoggedCommit */
/** @typedef {{ sha: string, hits: string[] }} Candidate 碰了先合后审路径的一个主线提交 */
/** @typedef {{ number: number, title: string, mergedAt: unknown, head: string, mergeCommit: string, files: string[], state: string | null, description: string }} MergedPr 合并后待补审的一个 PR */
/** @typedef {{ done: MergedPr[], failed: MergedPr[], unreviewed: MergedPr[], problems: string[] }} Classified */
/** @typedef {Classified & { days: number, afterMergePaths: string[], since: string | null, note?: string }} Pending */
/** @typedef {{ oid?: unknown, status?: { context?: { state?: unknown, description?: unknown } | null } | null }} StatusCommit */
/** @typedef {{ number?: unknown, title?: unknown, state?: unknown, mergedAt?: unknown, headRefOid?: unknown, baseRefName?: unknown, mergeCommit?: { oid?: unknown } | null, commits?: { nodes?: { commit?: StatusCommit }[] } }} GraphqlPr GraphQL 里一个 PR 用到的字段 */
/** @typedef {{ associatedPullRequests?: { nodes?: unknown } } | null | undefined} GraphqlCommit */
/** @typedef {{ number: number, state: string, title: string, headRefOid: string, mergeCommit?: { oid?: unknown } | null }} PrView gh pr view 里用到的几个字段 */

// ---------- 合并后补审（创始人 2026-10-03 晚「1+2+3」的第 3 条） ----------
//
// 清单（packages/conventions/high-risk-paths.json）里标了 review: after-merge 的条目（CI 判法那几份）：合并闸不等第二意见、
// 先合；合并后由这里补审。「哪些该补」只按主线上的那份清单认，从这个标记第一次出现在主线上的那个提交起算（在那之前合的 PR
// 走的是先审后合，不归这里管），最多往回看 14 天。只认提交状态：PR 头上有通过的 second-opinion 才算补过了。
// 补审没过的不重跑（重跑只会撞出一次随机的「通过」），等修复 PR 或 revert 合进去，再用 --after-merge-resolve 记成已处理。

export const AFTER_MERGE_DAYS = 14;
export const RISK_PATHS_FILE = 'packages/conventions/high-risk-paths.json';

/**
 * 主线上那份清单 → 每条的路径、是不是先合后审（认最具体的那条要用全部）。认不出回一句为什么（调用方判没查成）：
 * 不是 JSON、没有 paths、有一条没有 path、review 写了 after-merge 以外的东西。
 * @param {string} text
 * @returns {RiskRule[] | string}
 */
export function riskRules(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return `不是合法的 JSON（${messageOf(e)}）`;
  }
  const paths = isObjectLike(raw) && !Array.isArray(raw) ? raw.paths : undefined;
  if (!Array.isArray(paths) || paths.length === 0) return '没有 paths 列表（或是空的）';
  /** @type {RiskRule[]} */
  const rules = [];
  for (const [i, item] of paths.entries()) {
    if (!isObjectLike(item) || typeof item.path !== 'string' || !item.path.trim())
      return `paths 第 ${i + 1} 条认不出（没有 path）`;
    if (item.review !== undefined && item.review !== 'after-merge')
      return `paths 第 ${i + 1} 条（${item.path}）的 review「${String(item.review)}」认不出`;
    rules.push({ path: item.path.trim(), afterMerge: item.review === 'after-merge' });
  }
  return rules;
}

/**
 * 改到的文件里按「最具体（路径最长）的那条规则」算是先合后审的；改名的新旧名字都算（和合并闸的 riskyFiles 一个判法）。
 * @param {readonly ChangedFile[]} files
 * @param {readonly RiskRule[]} rules
 * @returns {string[]}
 */
export function afterMergeHits(files, rules) {
  /** @type {string[]} */
  const hits = [];
  for (const f of files) {
    for (const name of [f.path, f.previous]) {
      if (!name || hits.includes(name)) continue;
      const rule = rules
        .filter((r) => (r.path.endsWith('/') ? name.startsWith(r.path) : name === r.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (rule?.afterMerge) hits.push(name);
    }
  }
  return hits;
}

/**
 * `git log -z --name-status --format=%x01%H %cI` 的输出 → 每个提交改了哪些文件（改名、复制带上旧名字）。认不出抛。
 * @param {unknown} stdout
 * @returns {LoggedCommit[]}
 */
export function parseNameStatusLog(stdout) {
  /** @type {LoggedCommit[]} */
  const commits = [];
  for (const chunk of String(stdout).split('\x01').slice(1)) {
    const cut = chunk.indexOf('\0');
    const header = (cut < 0 ? chunk : chunk.slice(0, cut)).trim();
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(header);
    if (!m) throw new NotChecked(`git log 的输出认不出（提交那一行是「${header.slice(0, 60)}」）`);
    const [, sha = '', date = ''] = m;
    const tokens = (cut < 0 ? '' : chunk.slice(cut + 1)).split('\0').map((t) => t.replace(/^\n/, ''));
    /** @type {ChangedFile[]} */
    const files = [];
    for (let i = 0; i < tokens.length; ) {
      const st = tokens[i] ?? '';
      if (st === '') {
        i++;
        continue;
      }
      if (!/^[ACDMRTUXB]\d*$/.test(st))
        throw new NotChecked(`git log 的输出认不出（${sha.slice(0, 7)} 的改动状态是「${st.slice(0, 20)}」）`);
      const two = st[0] === 'R' || st[0] === 'C';
      const names = tokens.slice(i + 1, i + (two ? 3 : 2));
      const [first, second] = names;
      if (two) {
        if (names.length !== 2 || !first || !second)
          throw new NotChecked(`git log 的输出认不出（${sha.slice(0, 7)} 少了文件名）`);
        files.push({ path: second, previous: first });
        i += 3;
      } else {
        if (names.length !== 1 || !first)
          throw new NotChecked(`git log 的输出认不出（${sha.slice(0, 7)} 少了文件名）`);
        files.push({ path: first });
        i += 2;
      }
    }
    commits.push({ sha, date, files });
  }
  return commits;
}

/** @type {Set<string>} */
const SO_STATES = new Set(['success', 'failure', 'error', 'pending', 'expected']);

/**
 * 一次问 GitHub：这几个主线提交各是哪个 PR 合进来的、那个 PR 头上的 second-opinion 是什么。
 * @param {readonly string[]} shas
 * @returns {string}
 */
export function prsOfCommitsQuery(shas) {
  const pr =
    'number title state mergedAt headRefOid baseRefName mergeCommit { oid } commits(last: 1) { nodes { commit { oid status { context(name: "second-opinion") { state description } } } } }';
  const parts = shas.map((sha, i) => {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new NotChecked(`提交号「${String(sha).slice(0, 60)}」认不出`);
    return `c${i}: object(oid: "${sha}") { ... on Commit { associatedPullRequests(first: 5) { nodes { ${pr} } } } }`;
  });
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${parts.join(' ')} } }`;
}

/**
 * 每个碰了先合后审路径的主线提交对到 PR 上（合并提交对得上的优先，其次合进 main 的），按 PR 头上的 second-opinion 分：
 * done（success）、failed（failure：补审没过，等修复或 revert）、unreviewed（没有、pending、error）。对不上 PR 的进 problems。
 * GitHub 回的样子认不出抛 NotChecked。
 * @param {readonly Candidate[]} candidates
 * @param {unknown} repoData
 * @returns {Classified}
 */
export function classifyAfterMerge(candidates, repoData) {
  if (!isObjectLike(repoData)) throw new NotChecked('GitHub 回的 GraphQL 认不出（没有 data.repository）');
  /** @type {Map<number, MergedPr>} */
  const byPr = new Map();
  /** @type {string[]} */
  const problems = [];
  candidates.forEach((c, i) => {
    const where = `${c.sha.slice(0, 7)}（改到 ${c.hits.join('、')}）`;
    const node = /** @type {GraphqlCommit} */ (repoData[`c${i}`]);
    if (node == null) {
      problems.push(`${where}：GitHub 上找不到这个提交`);
      return;
    }
    const nodes = node.associatedPullRequests?.nodes;
    if (!Array.isArray(nodes))
      throw new NotChecked(`GitHub 回的 ${c.sha.slice(0, 7)} 认不出（没有 associatedPullRequests）`);
    // 下面对每个要用的字段都有显式判断（number、headRefOid、状态），GitHub 回的样子不对就抛 NotChecked
    const prs = /** @type {(GraphqlPr | null | undefined)[]} */ (nodes);
    const pr =
      prs.find((p) => p?.mergeCommit?.oid === c.sha) ??
      prs.find((p) => p?.state === 'MERGED' && p?.baseRefName === 'main');
    if (!pr) {
      problems.push(`${where}：找不到合它进主线的 PR（直接推到主线的？没法按 PR 补审）`);
      return;
    }
    const head = pr.commits?.nodes?.[0]?.commit;
    const number = pr.number;
    const headOid = pr.headRefOid;
    if (
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      typeof headOid !== 'string' ||
      head?.oid !== headOid
    )
      throw new NotChecked(`GitHub 回的 #${number ?? '?'} 认不出（读不到它的头）`);
    const raw = head.status?.context?.state;
    const state = raw == null ? null : String(raw).toLowerCase();
    if (state !== null && !SO_STATES.has(state))
      throw new NotChecked(`#${number} 头上的 second-opinion 状态「${raw}」认不出`);
    const seen = byPr.get(number);
    if (seen) {
      for (const h of c.hits) if (!seen.files.includes(h)) seen.files.push(h);
      return;
    }
    byPr.set(number, {
      number,
      title: String(pr.title ?? ''),
      mergedAt: pr.mergedAt ?? null,
      head: headOid,
      mergeCommit: typeof pr.mergeCommit?.oid === 'string' ? pr.mergeCommit.oid : c.sha,
      files: [...c.hits],
      state,
      description: String(head.status?.context?.description ?? ''),
    });
  });
  const all = [...byPr.values()].sort((a, b) => a.number - b.number);
  return {
    done: all.filter((p) => p.state === 'success'),
    failed: all.filter((p) => p.state === 'failure'),
    unreviewed: all.filter((p) => p.state !== 'success' && p.state !== 'failure'),
    problems,
  };
}

/**
 * 合并后待补审的。git、gh 是起命令的两样（失败抛错、成功回 stdout）；fetchMain 不给就不取远端（开会话钩子刚取过）。
 * 读不到、认不出一律抛 NotChecked（调用方判没查成），不当成「没有待补审的」。主线上的清单还没有 after-merge 的条目时
 * 列表就是空的——那是真没有，不是没查成。
 * @param {{ git: (args: string[]) => string, gh: GhRun, fetchMain?: (() => void) | null, now?: number, days?: number }} deps
 * @returns {Pending}
 */
export function pendingAfterMerge({
  git,
  gh: ghRun,
  fetchMain = null,
  now = Date.now(),
  days = AFTER_MERGE_DAYS,
}) {
  if (fetchMain) {
    try {
      fetchMain();
    } catch (e) {
      throw new NotChecked(`取主线没成（${errText(e)}），不知道最近合了哪些 PR`);
    }
  }
  let listText;
  try {
    listText = git(['show', `origin/main:${RISK_PATHS_FILE}`]);
  } catch (e) {
    throw new NotChecked(`读不到主线上的 ${RISK_PATHS_FILE}（${errText(e)}）`);
  }
  const rules = riskRules(listText);
  if (typeof rules === 'string') throw new NotChecked(`主线上的 ${RISK_PATHS_FILE} ${rules}`);
  const afterMergePaths = rules.filter((r) => r.afterMerge).map((r) => r.path);
  /** @type {Omit<Pending, 'since' | 'note'>} */
  const base = { days, afterMergePaths, done: [], failed: [], unreviewed: [], problems: [] };
  if (afterMergePaths.length === 0)
    return { ...base, since: null, note: '主线上的清单还没有标 review: after-merge 的条目' };
  // 先合后审从哪天起：这个标记第一次出现在主线上的那个提交（-S 列的是标记个数变了的提交，最后一行最早）
  /** @type {string} */
  let intro;
  try {
    intro = git([
      'log',
      'origin/main',
      '--first-parent',
      '--format=%H %cI',
      '-S',
      '"after-merge"',
      '--',
      RISK_PATHS_FILE,
    ]);
  } catch (e) {
    throw new NotChecked(`查不出先合后审是哪天起的（${errText(e)}）`);
  }
  const oldest = String(intro).split('\n').filter(Boolean).at(-1) ?? '';
  const startedAt = Date.parse(oldest.split(' ')[1] ?? '');
  if (!Number.isFinite(startedAt))
    throw new NotChecked(`查不出先合后审是哪天起的（git log -S 的输出认不出：「${oldest.slice(0, 60)}」）`);
  const since = new Date(Math.max(now - days * 86_400_000, startedAt)).toISOString();
  /** @type {string} */
  let logText;
  /** @type {string} */
  let count;
  try {
    logText = git([
      '-c',
      'core.quotePath=false',
      'log',
      'origin/main',
      `--since=${since}`,
      '--first-parent',
      '--diff-merges=first-parent',
      '--name-status',
      '-M',
      '-z',
      '--format=%x01%H %cI',
    ]);
    count = git(['rev-list', '--count', '--first-parent', `--since=${since}`, 'origin/main']);
  } catch (e) {
    throw new NotChecked(`git log 没跑成（${errText(e)}）`);
  }
  const commits = parseNameStatusLog(logText);
  if (String(commits.length) !== String(count).trim())
    throw new NotChecked(
      `git log 读出 ${commits.length} 个提交，rev-list 说有 ${String(count).trim()} 个：输出认不出`,
    );
  const candidates = commits
    .map((c) => ({ ...c, hits: afterMergeHits(c.files, rules) }))
    .filter((c) => c.hits.length > 0);
  if (candidates.length === 0) return { ...base, since };
  /** @type {unknown} */
  let data;
  try {
    const out = ghRun([
      'api',
      'graphql',
      '-F',
      'owner={owner}',
      '-F',
      'name={repo}',
      '-f',
      `query=${prsOfCommitsQuery(candidates.map((c) => c.sha))}`,
    ]);
    data = JSON.parse(out)?.data?.repository;
  } catch (e) {
    if (e instanceof NotChecked) throw e;
    throw new NotChecked(`问 GitHub 这几个提交是哪个 PR 合的没成（${errText(e)}）`);
  }
  return { ...base, since, ...classifyAfterMerge(candidates, data) };
}

const SWEEP_HINT = '--after-merge-sweep --author-family <写它的模型族>';
/** @param {MergedPr} p */
const prLine = (p) =>
  `- #${p.number} ${p.title}（合并于 ${String(p.mergedAt ?? '?').slice(0, 10)}，改到 ${p.files.join('、')}）`;

/**
 * --after-merge-pending 给人看的那几行。
 * @param {Pending} p
 */
export function formatPending(p) {
  if (p.note) return `没有合并后待补审的：${p.note}。`;
  const out = [
    `合并后补审：主线上 ${String(p.since).slice(0, 16).replace('T', ' ')}（UTC）之后合并、改到先合后审路径的 PR 共 ${p.done.length + p.failed.length + p.unreviewed.length} 个，补审通过 ${p.done.length} 个。`,
  ];
  if (p.unreviewed.length > 0)
    out.push(`还没补审 ${p.unreviewed.length} 个（跑 ${SWEEP_HINT}）：`, ...p.unreviewed.map(prLine));
  if (p.failed.length > 0)
    out.push(
      `补审没过、等修复或 revert ${p.failed.length} 个：`,
      ...p.failed.map(
        (x) =>
          `${prLine(x)}：${x.description || '没过'}；修复合了跑 --after-merge-resolve ${x.number} --by <修复 PR 号>，或 git revert ${x.mergeCommit.slice(0, 7)}`,
      ),
    );
  if (p.problems.length > 0)
    out.push(`对不上 PR 的提交 ${p.problems.length} 个：`, ...p.problems.map((x) => `- ${x}`));
  if (p.unreviewed.length + p.failed.length + p.problems.length === 0) out.push('没有待补审的。');
  return out.join('\n');
}

/**
 * 取一次主线（和审 PR 时一样：先照常取，不行再绕开代理直连）。
 * @param {string} repo
 */
export function fetchMain(repo) {
  const refs = ['fetch', '-q', 'origin', 'main'];
  try {
    sh('git', refs, repo);
  } catch (first) {
    try {
      sh('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', ...refs], repo, directEnv());
    } catch (second) {
      throw new Error(`${errText(first)}；绕开代理再取也没成：${errText(second)}`);
    }
  }
}

/**
 * 起 git、gh 的真家伙（测试换成假的）：失败抛错，成功回 stdout。
 * @param {string} repo
 */
export function realDeps(repo) {
  return {
    git: (/** @type {string[]} */ a) => sh('git', a, repo),
    gh: (/** @type {string[]} */ a) => {
      if (!findBin('gh')) throw new Error('这台机器没装 gh（PATH 上找不到）');
      return gh(a, repo);
    },
    fetchMain: () => fetchMain(repo),
  };
}

/**
 * --after-merge-resolve <原 PR> --by <修复或 revert 的 PR>：补审没过的问题已经修好、合进主线，在原 PR 的头上写通过，
 * 待补审清单就不再列它。只认「原 PR 头上是补审没过」「修复 PR 已合并」这两样都对得上的，免得拿它绕过补审。
 * @param {{ o: Options, repo: string, log: Log, deps?: ReviewDeps | null }} opts
 * @returns {Promise<number>}
 */
export async function afterMergeResolve({ o, repo, log, deps: given = null }) {
  const { resolve: original, by } = o;
  if (
    typeof original !== 'number' ||
    !Number.isInteger(original) ||
    original <= 0 ||
    typeof by !== 'number' ||
    !Number.isInteger(by) ||
    by <= 0
  )
    throw new NotChecked('要 --after-merge-resolve <原 PR 号> --by <修复或 revert 的 PR 号>');
  if (original === by) throw new NotChecked('--by 不能是它自己');
  const deps = given ?? reviewDeps(repo);
  /** @param {number} n */
  const view = (n) =>
    /** @type {PrView} */ (
      JSON.parse(deps.gh(['pr', 'view', String(n), '--json', 'number,state,title,headRefOid,mergeCommit']))
    );
  const orig = view(original);
  const fix = view(by);
  if (orig.state !== 'MERGED')
    throw new NotChecked(
      `#${original} 不是已合并的 PR（${orig.state}）：没合并的照常审（--pr），不走合并后补审`,
    );
  if (fix.state !== 'MERGED')
    throw new NotChecked(`#${by} 还没合并（${fix.state}）：修复或 revert 合进主线之后再记`);
  const current = currentSecondOpinion(deps.gh, orig.headRefOid);
  if (current?.state === 'success') {
    console.log(`#${original} 头上的 second-opinion 已经是通过（${current.description}），不用再记`);
    return 0;
  }
  if (current?.state !== 'failure')
    throw new NotChecked(
      `#${original} 头上的 second-opinion 是「${current?.state ?? '没有'}」，不是补审没过：还没补审的先跑 --after-merge-sweep`,
    );
  const fixAt = String(fix.mergeCommit?.oid ?? '').slice(0, 7);
  let url;
  try {
    url = await postToPr(
      repo,
      original,
      [
        `**合并后补审：已处理**——补审没过的问题由 #${fix.number}（${fix.title}${fixAt ? `，合并提交 ${fixAt}` : ''}）处理。`,
        '',
        `原来的结论：${current.description}`,
      ].join('\n'),
      deps.gh,
      deps.runs,
    );
    log(`贴到了 PR：${url}`);
  } catch (e) {
    log(`没贴上 PR：${messageOf(e)}`);
  }
  setStatus(
    deps.gh,
    orig.headRefOid,
    { state: 'success', description: `合并后补审没过的问题已由 #${fix.number} 处理` },
    url,
  );
  console.log(`#${original} 记成已处理（由 #${fix.number}）：头 ${orig.headRefOid.slice(0, 7)} 上写了通过`);
  return 0;
}
