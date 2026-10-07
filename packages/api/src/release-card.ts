// /france 页「发版」卡（#1231，GET /api/france/release-card）：主线最新提交和它的 CI、法国在用的提交、两者差几个提交（列最近 5 个合进去的 PR）、
// 主线最近做完的一个任务（最近合并的 PR 和它关的单）。只读，不带任何会改法国的东西。
// 改这里之前必须知道：
// - 四行各自读、各自带「查成了 / 没查成 + 原因」：读不到 GitHub、读不到法国在用的提交，那一行写没查成和原因；
//   两个提交号有一个没读到，「差几个」算不出就写没查成，不拿 0、空列表或「法国已经是最新」顶。
// - GitHub 现读（计划和提交以 GitHub 为准，库里没有副本），整张卡限时 READ_TIMEOUT_MS；到时没读完的行照「没查成」报。
// - 提交号两边都是 40 位全号：法国在用的来自 current 链接，主线头来自 GitHub；比较用全号，不用短号。
// - 同一份文件里还有更新日志页「已发布的提交」（#1255，GET /api/france/released-commits）：读发布历史里切上去的几条，和发版卡共用同一个读口（ReleaseCardPort.history）。
// - 「差几个」用 GitHub compare 的 ahead_by；最近 PR 从合并提交的说明（squash 合并末尾的 (#号)）里认，不是 PR 合并的提交只数个数。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReleaseFactsReader } from '@fleet-dao/github';
import {
  type ReleaseCard,
  ReleaseCardSchema,
  type ReleasedCommits,
  ReleasedCommitsSchema,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { deployedAtFromHistory, RELEASES_DIR, readDeployLagInput } from '@fleet-dao/store';
import type { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { type FranceReleasePort, parseTrainState } from './france-release.ts';
import { reply } from './http.ts';
import type { Store } from './ports.ts';
import type { ReleaseRequestPort } from './release-request.ts';
import { findSelfRepo, SELF_REPO_NAME } from './self-repo.ts';
import type { CockpitEnv } from './session.ts';

/** 到时限就不等了：实现不认 signal（不停下来）也照样按读不到报。 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}

/** 整张卡最多等多久：页面在等，GitHub 客户端自己的重试不能全让人干等。 */
export const CARD_READ_TIMEOUT_MS = 12_000;
/** 列最近几个合进去的 PR。 */
export const CARD_PR_LIMIT = 5;

/** 发版卡要的三样（main.ts 正式装配给真的；测试换替身）。 */
export interface ReleaseCardPort {
  facts: ReleaseFactsReader;
  /** 法国在用的提交（发布目录的 current 链接）：还没发布过是 sha null，读不到带原因。同 store 的 readDeployLagInput().current。 */
  deployed(): { sha: string | null } | { error: string };
  /** 这个提交最近一次切上去的时间（发布历史）；历史里没记这个提交回 null；读不了抛错。 */
  deployedAt(sha: string): Promise<string | null>;
  /** 发布历史（release.sh 的 .history）的全文，「已发布的提交」列表（#1255）读它；读不了抛错。没给（开发、内存版）列表写没接上。 */
  history?(): Promise<string>;
}

type Card = ReleaseCard;
type Rows = Omit<Card, 'action'>;
type CommitLine = Extract<Card['mainline'], { state: 'ok' }>['commit'];

const FULL_SHA = /^[0-9a-f]{40}$/;

/** 合并提交说明末尾的 (#号)：squash 合并的写法。 */
const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;
/** PR 正文里的关单行（Closes / Fixes / Resolves #号，GitHub 认的那几个词）。 */
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[:\s]+#(\d+)/gi;

export function prsFromTitles(commits: readonly { title: string }[]): {
  prs: { number: number; title: string }[];
  nonPr: number;
} {
  const prs: { number: number; title: string }[] = [];
  let nonPr = 0;
  for (const c of commits) {
    const m = PR_SUFFIX.exec(c.title);
    if (!m?.[1]) {
      nonPr += 1;
      continue;
    }
    if (prs.length < CARD_PR_LIMIT) prs.push({ number: Number(m[1]), title: c.title.replace(PR_SUFFIX, '') });
  }
  return { prs, nonPr };
}

export function closesOf(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(CLOSES)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export interface BuildReleaseCardInput {
  port: ReleaseCardPort | undefined;
  /** 「发布到法国」按钮要的几样（release-request.ts）；没给（开发、内存版）按钮置灰并写没接上。 */
  request?: ReleaseRequestPort | undefined;
  /** 进度记录的读口（france-release.ts）：判有没有发版在走、最近一趟的结果。 */
  franceRelease?: FranceReleasePort | undefined;
  store: Store;
  now: () => Date;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

async function buildRows(input: BuildReleaseCardInput): Promise<Rows> {
  const asOf = input.now().toISOString();
  const { port } = input;
  const allUnreadable = (why: string): Rows => ({
    mainline: { state: 'unreadable', why },
    deployed: { state: 'unreadable', why },
    gap: { state: 'unreadable', why },
    lastDone: { state: 'unreadable', why },
    asOf,
  });
  if (!port)
    return allUnreadable('这台后端没接上发版卡要读的东西（开发、内存版）：到法国那台的驾驶舱开才有这一块');
  let repo: Awaited<ReturnType<typeof findSelfRepo>>;
  try {
    repo = await findSelfRepo(input.store);
  } catch (e) {
    return allUnreadable(`读受管的仓列表没成：${errMessage(e)}`);
  }
  if (repo === undefined) {
    return allUnreadable(`受管的仓里没有 ${SELF_REPO_NAME}，不知道去哪个仓读主线和 PR`);
  }
  const ref = { owner: repo.owner, name: repo.name };
  const timeoutMs = input.timeoutMs ?? CARD_READ_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const why = (e: unknown) => (timeout.aborted ? `${timeoutMs / 1000} 秒没读完` : errMessage(e));
  const read = <T>(work: () => Promise<T>): Promise<T> => untilAborted(work(), signal);
  const line = (c: { sha: string; title: string; committedAt: string }): CommitLine => ({
    sha: c.sha,
    short: c.sha.slice(0, 12),
    title: c.title,
    at: c.committedAt,
  });

  // ① 主线头（它的 CI 单独读：提交读到了、CI 没读到，提交那一半照给）
  const mainlineP: Promise<{ head?: CommitLine; row: Card['mainline'] }> = (async () => {
    let head: Awaited<ReturnType<ReleaseFactsReader['mainlineHead']>>;
    try {
      head = await read(() => port.facts.mainlineHead(ref, signal));
    } catch (e) {
      return { row: { state: 'unreadable', why: `读主线头失败：${why(e)}` } };
    }
    if (!FULL_SHA.test(head.sha)) {
      return { row: { state: 'unreadable', why: '主线头的提交号认不出（不是 40 位）' } };
    }
    let ci: Extract<Card['mainline'], { state: 'ok' }>['ci'];
    try {
      const r = await read(() => port.facts.mainCi(ref, head.sha, signal));
      ci = r.state === 'green' ? { state: 'green' } : { state: r.state, detail: r.detail };
    } catch (e) {
      ci = { state: 'unreadable', why: `读主线头的 CI 失败：${why(e)}` };
    }
    const commit = line(head);
    return { head: commit, row: { state: 'ok', commit, ci } };
  })();

  // ② 法国在用的提交
  const deployedP: Promise<{ sha?: string; row: Card['deployed'] }> = (async () => {
    let cur: ReturnType<ReleaseCardPort['deployed']>;
    try {
      cur = port.deployed();
    } catch (e) {
      return { row: { state: 'unreadable', why: `读法国在用的提交失败：${errMessage(e)}` } };
    }
    if ('error' in cur) return { row: { state: 'unreadable', why: `读法国在用的提交失败：${cur.error}` } };
    if (cur.sha === null) {
      return { row: { state: 'unreadable', why: '法国还没有发布过任何一版（current 链接不在）' } };
    }
    const sha = cur.sha;
    if (!FULL_SHA.test(sha)) {
      return {
        row: { state: 'unreadable', why: `法国在用的提交号认不出（不是 40 位）：${sha.slice(0, 20)}` },
      };
    }
    const [title, at] = await Promise.all([
      read(() => port.facts.commit(ref, sha, signal)).then(
        (c) => ({ ok: true as const, c }),
        (e: unknown) => ({ ok: false as const, why: `读它的标题失败：${why(e)}` }),
      ),
      read(() => port.deployedAt(sha)).then(
        (t) => ({ ok: true as const, t }),
        (e: unknown) => ({ ok: false as const, why: `读发布历史失败：${why(e)}` }),
      ),
    ]);
    return {
      sha,
      row: {
        state: 'ok',
        sha,
        short: sha.slice(0, 12),
        title: title.ok ? title.c.title : null,
        titleWhy: title.ok ? null : title.why,
        deployedAt: at.ok ? at.t : null,
        deployedAtWhy: at.ok ? (at.t === null ? '发布历史里没有这个提交的记录' : null) : at.why,
      },
    };
  })();

  // ④ 最近做完的一个任务（和前三行互不相干，一起读）
  const lastDoneP: Promise<Card['lastDone']> = (async () => {
    let pr: Awaited<ReturnType<ReleaseFactsReader['lastMergedPull']>>;
    try {
      pr = await read(() => port.facts.lastMergedPull(ref, signal));
    } catch (e) {
      return { state: 'unreadable', why: `读主线最近合并的 PR 失败：${why(e)}` };
    }
    const prPart = { number: pr.number, title: pr.title, mergedAt: pr.mergedAt };
    const [first, ...others] = closesOf(pr.body);
    if (first === undefined) return { state: 'ok', pr: prPart, issue: { state: 'none' } };
    try {
      const issue = await read(() => port.facts.issueTitle(ref, first, signal));
      return {
        state: 'ok',
        pr: prPart,
        issue: { state: 'ok', number: issue.number, title: issue.title, alsoCloses: others },
      };
    } catch (e) {
      return {
        state: 'ok',
        pr: prPart,
        issue: { state: 'unreadable', number: first, why: `读 #${first} 失败：${why(e)}` },
      };
    }
  })();

  const [mainline, deployed, lastDone] = await Promise.all([mainlineP, deployedP, lastDoneP]);

  // ③ 差几个：两边的提交号都读到了才算
  let gap: Card['gap'];
  if (mainline.head === undefined || deployed.sha === undefined) {
    const missing = [
      mainline.head === undefined ? '主线头' : null,
      deployed.sha === undefined ? '法国在用的提交' : null,
    ]
      .filter(Boolean)
      .join('、');
    gap = { state: 'unreadable', why: `${missing}没读到，差几个算不出（不当成「已是最新」）` };
  } else if (mainline.head.sha === deployed.sha) {
    gap = { state: 'same' };
  } else {
    const deployedSha = deployed.sha;
    const mainSha = mainline.head.sha;
    try {
      const c = await read(() => port.facts.compare(ref, deployedSha, mainSha, signal));
      if (c.status === 'identical') gap = { state: 'same' };
      else if (c.status === 'ahead' && c.aheadBy >= 1) {
        const { prs, nonPr } = prsFromTitles(c.recent);
        gap = { state: 'ahead', count: c.aheadBy, prs, nonPr };
      } else {
        gap = {
          state: 'unreadable',
          why: `法国在用的提交和主线头不是前后关系（GitHub 比较回「${c.status}」）：它不在主线上，或比主线新`,
        };
      }
    } catch (e) {
      gap = { state: 'unreadable', why: `比较法国在用的提交和主线头失败：${why(e)}` };
    }
  }

  return { mainline: mainline.row, deployed: deployed.row, gap, lastDone, asOf };
}

type Action = Card['action'];
type Last = Action['last'];

const NO_LAST: Last = { state: 'none', target: null, at: null, why: null, phase: null };

/** 最近一次点击的结果：请求还没被接走 → pending；root 拒了的比进度记录新 → refused；否则看进度记录里这一趟；都没有 → none。读不到带原因。 */
async function readLast(
  request: ReleaseRequestPort,
  franceRelease: FranceReleasePort | undefined,
): Promise<{ last: Last; busy: boolean; busyWhy: string | null }> {
  let pending: boolean;
  try {
    pending = await request.pendingRequest();
  } catch (e) {
    const why = `读上一份请求在不在失败：${errMessage(e)}`;
    return { last: { ...NO_LAST, state: 'unreadable', why }, busy: true, busyWhy: why };
  }
  let train: { stateJson: string | null; marker: boolean } | undefined;
  let trainWhy: string | null = null;
  if (franceRelease === undefined) trainWhy = '这台后端没接上 release-train 进度记录的读取';
  else {
    try {
      train = await franceRelease.readStateFiles();
    } catch (e) {
      trainWhy = `读 release-train 进度记录失败：${errMessage(e)}`;
    }
  }
  let parsed: ReturnType<typeof parseTrainState> | null = null;
  if (train?.stateJson != null) {
    parsed = parseTrainState(train.stateJson);
    if (!parsed.ok) trainWhy = parsed.why;
  }
  let refused: { at: string; sha: string | null; why: string } | null = null;
  let lastWhy: string | null = null;
  try {
    const text = await request.readLast();
    if (text !== null) {
      const o = JSON.parse(text) as { outcome?: unknown; at?: unknown; sha?: unknown; why?: unknown };
      if (o.outcome === 'refused' && typeof o.at === 'string' && typeof o.why === 'string') {
        refused = { at: o.at, sha: typeof o.sha === 'string' ? o.sha : null, why: o.why };
      }
    }
  } catch (e) {
    lastWhy = `读最近一次请求的结果失败：${errMessage(e)}`;
  }
  const running = parsed?.ok === true && parsed.status === 'running';
  const busyWhy = pending ? '上一份发布请求还没被法国接走' : running ? '已有发版在走' : trainWhy;
  const busy = pending || running || trainWhy !== null;
  if (pending) return { last: { ...NO_LAST, state: 'pending' }, busy, busyWhy };
  if (
    refused !== null &&
    (parsed?.ok !== true || parsed.updatedAt === null || refused.at >= parsed.updatedAt)
  ) {
    return {
      last: { state: 'refused', target: refused.sha, at: refused.at, why: refused.why, phase: null },
      busy,
      busyWhy,
    };
  }
  if (parsed?.ok === true) {
    return {
      last: {
        state: parsed.status,
        target: parsed.target,
        at: parsed.updatedAt,
        why: parsed.why,
        phase: parsed.phase,
      },
      busy,
      busyWhy,
    };
  }
  const unreadable = trainWhy ?? lastWhy;
  if (unreadable !== null) {
    return { last: { ...NO_LAST, state: 'unreadable', why: unreadable }, busy, busyWhy };
  }
  return { last: NO_LAST, busy, busyWhy };
}

/** 「发布到法国」按钮：能不能点、不能点的原因（每条一句话）、最近一次点击的结果。读不到的一律按不能点算，不拿「没问题」顶。 */
export async function buildAction(input: BuildReleaseCardInput, rows: Rows): Promise<Action> {
  const request = input.request;
  if (!request) {
    return {
      state: 'blocked',
      reasons: ['这台后端没接上发布请求（开发、内存版）：到法国那台的驾驶舱点'],
      installed: false,
      last: NO_LAST,
    };
  }
  const reasons: string[] = [];
  let installed = false;
  try {
    const r = await request.receiverInstalled();
    installed = r.ok;
    if (!r.ok) reasons.push(r.why);
  } catch (e) {
    reasons.push(`法国装没装发版接活单元没查成：${errMessage(e)}`);
  }
  const { last, busy, busyWhy } = await readLast(request, input.franceRelease);
  if (busy && busyWhy !== null) reasons.push(busyWhy);
  if (rows.mainline.state !== 'ok') reasons.push(`主线头没读到：${rows.mainline.why}`);
  else if (rows.mainline.ci.state === 'unreadable') reasons.push(`主线 CI 没读到：${rows.mainline.ci.why}`);
  else if (rows.mainline.ci.state !== 'green') {
    reasons.push(
      `主线 CI 不是绿的（${rows.mainline.ci.state === 'red' ? '红' : '还在跑'}）：${rows.mainline.ci.detail}`,
    );
  }
  if (rows.deployed.state !== 'ok') reasons.push(`法国在用的提交没读到：${rows.deployed.why}`);
  if (rows.gap.state === 'same') reasons.push('法国已经是最新，没有要发的');
  else if (rows.gap.state === 'unreadable') reasons.push(`差几个没查成：${rows.gap.why}`);
  return { state: reasons.length === 0 ? 'ready' : 'blocked', reasons, installed, last };
}

export async function buildReleaseCard(input: BuildReleaseCardInput): Promise<Card> {
  const rows = await buildRows(input);
  return { ...rows, action: await buildAction(input, rows) };
}

/** 「已发布的提交」最多列几条（每条还要去 GitHub 读一次标题，不拉太长）。 */
export const RELEASED_COMMITS_LIMIT = 20;

type ReleaseEvent = 'release' | 'rollback' | 'auto-rollback';
const SWITCH_EVENTS: readonly string[] = ['release', 'rollback', 'auto-rollback'];

/**
 * 发布历史（每行 `时间 提交号 事件 [unmerged]`）里「切上去」的几条，新的在前，最多 limit 条。
 * unhealthy、recovered 不是切版本；提交号不是 40 位全号、时间认不出的行抛错（不悄悄跳过：历史坏了要看得见）。
 */
export function releasedFromHistory(
  history: string,
  limit: number = RELEASED_COMMITS_LIMIT,
): { sha: string; at: string; event: ReleaseEvent }[] {
  const out: { sha: string; at: string; event: ReleaseEvent }[] = [];
  for (const raw of history.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const [time, sha, event] = line.split(/\s+/);
    if (event === undefined || !SWITCH_EVENTS.includes(event)) continue;
    if (!time || Number.isNaN(Date.parse(time))) {
      throw new Error(`发布历史里「${line.slice(0, 60)}」的时间认不出`);
    }
    if (!sha || !FULL_SHA.test(sha)) {
      throw new Error(`发布历史里「${line.slice(0, 60)}」的提交号不是 40 位`);
    }
    out.push({ sha, at: time, event: event as ReleaseEvent });
  }
  return out.reverse().slice(0, limit);
}

export interface BuildReleasedCommitsInput {
  port: ReleaseCardPort | undefined;
  store: Store;
  now: () => Date;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

/** 更新日志页「已发布的提交」（#1255）：读不到整份写没查成 + 原因；某一条的标题读不到只那一条写原因。 */
export async function buildReleasedCommits(input: BuildReleasedCommitsInput): Promise<ReleasedCommits> {
  const asOf = input.now().toISOString();
  const unreadable = (why: string): ReleasedCommits => ({ state: 'unreadable', why, asOf });
  const { port } = input;
  if (!port?.history) {
    return unreadable('这台后端没接上法国发布历史的读取（开发、内存版）：到法国那台的驾驶舱开才有这一块');
  }
  const timeoutMs = input.timeoutMs ?? CARD_READ_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const why = (e: unknown) => (timeout.aborted ? `${timeoutMs / 1000} 秒没读完` : errMessage(e));
  const read = <T>(work: () => Promise<T>): Promise<T> => untilAborted(work(), signal);

  let rows: ReturnType<typeof releasedFromHistory>;
  try {
    const text = await read(() => port.history?.() ?? Promise.reject(new Error('没接上')));
    rows = releasedFromHistory(text);
  } catch (e) {
    return unreadable(`读法国发布历史失败：${why(e)}`);
  }

  let ref: { owner: string; name: string } | undefined;
  let refWhy: string | null = null;
  try {
    const repo = await findSelfRepo(input.store);
    if (repo === undefined) refWhy = `受管的仓里没有 ${SELF_REPO_NAME}，不知道去哪个仓读提交标题`;
    else ref = { owner: repo.owner, name: repo.name };
  } catch (e) {
    refWhy = `读受管的仓列表没成：${errMessage(e)}`;
  }

  type Title = { title: string | null; titleWhy: string | null };
  const titles = new Map<string, Promise<Title>>();
  const titleOf = (sha: string): Promise<Title> => {
    let p = titles.get(sha);
    if (p === undefined) {
      const repoRef = ref;
      p = repoRef
        ? read(() => port.facts.commit(repoRef, sha, signal)).then(
            (c): Title => ({ title: c.title, titleWhy: null }),
            (e: unknown): Title => ({ title: null, titleWhy: `读标题失败：${why(e)}` }),
          )
        : Promise.resolve<Title>({ title: null, titleWhy: `读标题没成：${refWhy ?? '没有仓'}` });
      titles.set(sha, p);
    }
    return p;
  };
  const commits = await Promise.all(
    rows.map(async (r) => ({
      sha: r.sha,
      short: r.sha.slice(0, 12),
      ...(await titleOf(r.sha)),
      at: r.at,
      event: r.event,
    })),
  );
  return { state: 'ok', commits, asOf };
}

export function registerReleaseCardRoutes(app: Hono<CockpitEnv>, deps: Deps): void {
  app.get('/france/released-commits', async (c) =>
    reply(
      c,
      ReleasedCommitsSchema,
      await buildReleasedCommits({
        port: deps.releaseCard,
        store: deps.store,
        now: deps.now,
        signal: c.req.raw.signal,
      }),
    ),
  );

  app.get('/france/release-card', async (c) =>
    reply(
      c,
      ReleaseCardSchema,
      await buildReleaseCard({
        port: deps.releaseCard,
        request: deps.releaseRequest,
        franceRelease: deps.franceRelease,
        store: deps.store,
        now: deps.now,
        signal: c.req.raw.signal,
      }),
    ),
  );
}

// —— 生产装配（main.ts 挂）用到的真实现 ——

// deployedAtFromHistory 在 @fleet-dao/store（readDeployLagInput 也要读它）；这里照旧从本文件出口，调用方不用改
export { deployedAtFromHistory };

export function liveReleaseCardPort(facts: ReleaseFactsReader, dir: string = RELEASES_DIR): ReleaseCardPort {
  return {
    facts,
    deployed: () => readDeployLagInput(dir).current,
    deployedAt: async (sha) => deployedAtFromHistory(await readFile(join(dir, '.history'), 'utf8'), sha),
    history: () => readFile(join(dir, '.history'), 'utf8'),
  };
}
