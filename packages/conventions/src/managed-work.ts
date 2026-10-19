import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptanceGate } from './acceptance-gate.ts';
import { closingIssues } from './closing-issues.ts';
import type { GhApi } from './gh-api.ts';
import { issueOfBranch } from './issue-branch.ts';
import type { Gh } from './issue-new.ts';
import {
  type FeedbackEvent,
  feedbackDigest,
  parseFeedback,
  sameFeedbackRequest,
} from './managed-feedback.ts';
import { readManagedFeedback, readManagedFeedbackForGate } from './managed-feedback-github.ts';
import { issueColumnLinks } from './pr-columns.ts';
import {
  DeliveryCheckError,
  type ExternalDeliveryFact,
  type RunSpec,
  type RunStatus,
  readJson,
  runDir,
  runFiles,
  runsRoot,
  writeJson,
} from './work-run.ts';

export function feedbackApi(gh: Gh, repo: string): GhApi {
  const get = async (path: string, global = false): Promise<unknown> => {
    const r = await gh(['api', '--method', 'GET', global ? path : `/repos/${repo}${path}`]);
    if (r.code !== 0) throw new Error(`GitHub退回读取失败：${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout);
  };
  return {
    get: (p) => get(p),
    globalGet: (p) => get(p, true),
    getOrNull: (p) => get(p),
    async post(path, body) {
      const dir = join(tmpdir(), `fleet-feedback-${randomUUID()}`);
      mkdirSync(dir);
      const file = join(dir, 'body.json');
      try {
        writeFileSync(file, JSON.stringify(body));
        const r = await gh(['api', '--method', 'POST', `/repos/${repo}${path}`, '--input', file]);
        if (r.code !== 0) throw new Error(`GitHub退回写入未确认：${r.stderr || r.stdout}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
export async function managedPr(gh: Gh, branch: string) {
  const r = await gh([
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,headRefOid,state,mergedAt,isDraft',
    '--limit',
    '100',
  ]);
  if (r.code !== 0) throw new Error(`受管PR读取失败：${r.stderr || r.stdout}`);
  const values = JSON.parse(r.stdout);
  if (
    !Array.isArray(values) ||
    values.length !== 1 ||
    !Number.isSafeInteger(values[0].number) ||
    !/^[a-f0-9]{40}$/.test(values[0].headRefOid)
  )
    throw new Error('受管分支必须对应唯一真实PR');
  return values[0] as {
    number: number;
    headRefOid: string;
    state: string;
    mergedAt: string | null;
    isDraft: boolean;
  };
}
const SHA = /^[a-f0-9]{40}$/;
type AcceptanceState = 'open' | 'settled' | 'unknown';
type AcceptanceRead = (gh: Gh, repo: string, issue: number) => Promise<AcceptanceState>;

async function defaultAcceptance(gh: Gh, repo: string, issue: number): Promise<AcceptanceState> {
  try {
    const pending = await acceptanceGate(gh, `https://api.github.com/repos/${repo}`, issue);
    return pending ? 'open' : 'settled';
  } catch {
    // 验收账没读成不能当成已结清，也不能因此去重开工人。
    return 'unknown';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

async function ghValue(
  gh: Gh,
  args: string[],
): Promise<{ ok: true; value: unknown } | { ok: false; missing: boolean; why: string }> {
  let r: { code: number; stdout: string; stderr: string };
  try {
    r = await gh(args);
  } catch (e) {
    return { ok: false, missing: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout || `退出码 ${r.code}`).trim();
    return { ok: false, missing: /\b404\b|not found/i.test(why), why };
  }
  try {
    return { ok: true, value: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, missing: false, why: '响应不是JSON' };
  }
}

interface ListedPr {
  number: number;
  headRefOid: string;
  state: string;
  mergedAt: string | null;
  isDraft: boolean;
}

/** 列表里每一条都要有真实 PR 号和 head；认不出就整份作废，不当成没有 PR。 */
function asListed(value: unknown): ListedPr[] | null {
  if (!Array.isArray(value)) return null;
  const prs: ListedPr[] = [];
  for (const item of value) {
    const number = isRecord(item) ? asNumber(item.number) : null;
    if (!isRecord(item) || number === null || typeof item.headRefOid !== 'string') return null;
    if (!SHA.test(item.headRefOid)) return null;
    prs.push({
      number,
      headRefOid: item.headRefOid,
      state: typeof item.state === 'string' ? item.state : '',
      mergedAt: typeof item.mergedAt === 'string' ? item.mergedAt : null,
      isDraft: item.isDraft === true,
    });
  }
  return prs;
}

/** 需求关联：同仓关单关键字或「需求」栏 Closes，或这条分支前缀就是这张单。分片 Refs、别的仓、标题里的号都不算交付。 */
function deliversIssue(body: string, headRef: string, issue: number, repo: string): boolean {
  const links = issueColumnLinks(body);
  if (links.some((l) => l.number === issue && l.kind === 'closes' && !l.slice)) return true;
  if (links.some((l) => l.number === issue && l.slice)) return false;
  if (closingIssues(body, repo).includes(issue)) return true;
  return issueOfBranch(headRef)?.issue === issue;
}

function verifiedFact(value: unknown, spec: RunSpec, number: number): ExternalDeliveryFact | null {
  if (!isRecord(value) || !isRecord(value.head) || !isRecord(value.base) || !isRecord(value.base.repo))
    return null;
  const full = typeof value.base.repo.full_name === 'string' ? value.base.repo.full_name : '';
  const headRef = typeof value.head.ref === 'string' ? value.head.ref : '';
  const headSha = typeof value.head.sha === 'string' ? value.head.sha : '';
  const merge = typeof value.merge_commit_sha === 'string' ? value.merge_commit_sha : '';
  const mergedAt = typeof value.merged_at === 'string' ? value.merged_at : '';
  if (value.number !== number || value.merged !== true || value.state !== 'closed') return null;
  if (full.toLowerCase() !== spec.repo.toLowerCase() || headRef === '' || headRef === spec.branch)
    return null;
  if (!SHA.test(headSha) || !SHA.test(merge) || !Number.isFinite(Date.parse(mergedAt))) return null;
  if (!deliversIssue(typeof value.body === 'string' ? value.body : '', headRef, spec.issue, spec.repo))
    return null;
  return { repo: spec.repo, pr: number, head: headSha, mergeCommit: merge, mergedAt };
}

function acceptanceWord(state: AcceptanceState): string {
  if (state === 'open') return '验收责任仍未结清，保留';
  if (state === 'settled') return '验收责任已结清';
  return '验收责任没读成，保留未知责任，不当已交付';
}

/**
 * 本分支没有唯一真实 PR。只在同仓、需求关联、head、mergeCommit 都核到时才报外部交付；
 * issue 已关闭、别的仓、对不上的提交都不算。始终抛错：这里不能把本运行记完成。
 */
async function refuseMissingBranchDelivery(
  gh: Gh,
  spec: RunSpec,
  acceptance: AcceptanceRead,
  retainIntent: boolean,
): Promise<never> {
  const found = await ghValue(gh, [
    'pr',
    'list',
    '--repo',
    spec.repo,
    '--state',
    'merged',
    '--search',
    String(spec.issue),
    '--limit',
    '100',
    '--json',
    'number',
  ]);
  if (!found.ok) throw new DeliveryCheckError('retry', `他分支交付没读成：${found.why}`);
  if (!Array.isArray(found.value))
    throw new DeliveryCheckError('blocked', '他分支PR列表认不出，不能当已交付');
  if (found.value.length >= 100) {
    throw new DeliveryCheckError('blocked', '同仓已合并PR搜索结果可能被截断，没看全，不能判已交付，不续工人');
  }
  const numbers: number[] = [];
  for (const item of found.value) {
    const number = isRecord(item) ? asNumber(item.number) : null;
    if (number === null || number < 1) {
      throw new DeliveryCheckError('blocked', '他分支PR列表认不出，不能当已交付');
    }
    if (!numbers.includes(number)) numbers.push(number);
  }
  const verified: ExternalDeliveryFact[] = [];
  for (const number of numbers) {
    const pull = await ghValue(gh, ['api', `repos/${spec.repo}/pulls/${number}`]);
    if (!pull.ok) {
      if (pull.missing) continue;
      throw new DeliveryCheckError('retry', `外部PR #${number} 没读成：${pull.why}`);
    }
    const fact = verifiedFact(pull.value, spec, number);
    if (fact) verified.push(fact);
  }
  if (verified.length > 1) {
    const which = verified.map((v) => `#${v.pr}`).join('、');
    throw new DeliveryCheckError(
      'blocked',
      `同仓多条已合并PR都关联 #${spec.issue}（${which}），不能判哪条交付，不记完成、不续工人`,
    );
  }
  const fact = verified[0];
  if (!fact) {
    const why = retainIntent
      ? '本分支没有唯一真实PR，也没核到同仓已合并的需求关联PR；本机退回意图仍保留。issue是否关闭不能当作交付，不记完成、不续工人'
      : '本分支没有唯一真实PR，也没核到同仓已合并、关联本单、head和mergeCommit都真实的PR。issue是否关闭不能当作交付，不记完成、不续工人';
    throw new DeliveryCheckError(retainIntent ? 'review' : 'blocked', why);
  }
  const settled = await acceptance(gh, spec.repo, spec.issue);
  const why =
    `需求已由同仓其他真实PR #${fact.pr} 交付（head ${fact.head}，merge ${fact.mergeCommit}，${fact.mergedAt}）。` +
    `本分支没有PR，不伪造、不记完成。${acceptanceWord(settled)}。停止重复写码，工作树和会话保留。` +
    (retainIntent ? '本机退回意图仍保留，不能终结。' : '');
  throw new DeliveryCheckError('external', why, {
    acceptance: settled,
    external: fact,
    ...(retainIntent ? { retain: true } : {}),
  });
}

export async function validateManagedDelivery(
  gh: Gh,
  spec: RunSpec,
  requireMerged = true,
  root = runsRoot(),
  acceptance: AcceptanceRead = defaultAcceptance,
): Promise<void> {
  const intent = readJson<FeedbackEvent>(join(runDir(root, spec.repo, spec.issue), 'feedback-intent.json'));
  const listed = await ghValue(gh, [
    'pr',
    'list',
    '--repo',
    spec.repo,
    '--head',
    spec.branch,
    '--state',
    'all',
    '--json',
    'number,headRefOid,state,mergedAt,isDraft',
    '--limit',
    '100',
  ]);
  if (!listed.ok) {
    throw new DeliveryCheckError(
      'retry',
      requireMerged ? `受管PR读取失败：${listed.why}` : '重派前受管PR未读成',
    );
  }
  const prs = asListed(listed.value);
  if (!prs) {
    throw new DeliveryCheckError(
      'blocked',
      requireMerged ? '受管PR列表认不出，不能当已交付' : '重派前PR列表认不出',
    );
  }
  if (prs.length === 0) {
    if (!requireMerged) {
      if (intent) throw new DeliveryCheckError('review', '没有PR但保留退回意图，不能清运行');
      return;
    }
    await refuseMissingBranchDelivery(gh, spec, acceptance, intent !== null);
  }
  if (prs.length !== 1) {
    throw new DeliveryCheckError('blocked', '受管分支必须对应唯一真实PR，这是确定条件，不续工人');
  }
  const pr = prs[0];
  if (!pr) throw new DeliveryCheckError('blocked', '受管分支必须对应唯一真实PR，这是确定条件，不续工人');
  const { records } = await readManagedFeedbackForGate(feedbackApi(gh, spec.repo), pr.number, pr.headRefOid);
  if (intent) {
    const snapshot = await readManagedFeedback(feedbackApi(gh, spec.repo), pr.number, pr.headRefOid);
    if (
      !snapshot.reviews.some(
        (r) =>
          r.user.id === snapshot.source.writerId &&
          !!parseFeedback(r.body) &&
          sameFeedbackRequest(parseFeedback(r.body) as FeedbackEvent, intent),
      )
    )
      throw new DeliveryCheckError('review', '本机事务回执未核实；不能清除运行或记完成');
  }
  if (records.some((r) => !r.resolved))
    throw new DeliveryCheckError('review', '本机审查退回尚未解决；不能记完成');
  if (!requireMerged) return;
  if (!pr.mergedAt || pr.state !== 'MERGED') {
    throw new DeliveryCheckError('review', 'PR尚未真实合并，CLI成功退出不算交付');
  }
  const issue = await ghValue(gh, [
    'issue',
    'view',
    String(spec.issue),
    '--repo',
    spec.repo,
    '--json',
    'state',
  ]);
  if (!issue.ok) throw new DeliveryCheckError('retry', '需求单未读成，验收责任仍保留，不能记完成');
  if (!isRecord(issue.value) || issue.value.state !== 'CLOSED') {
    throw new DeliveryCheckError('review', '需求单未核实关闭，验收责任仍保留，不能记完成');
  }
}
async function managedWorkUnlocked(
  action: string,
  args: readonly string[],
  o: {
    gh: Gh;
    repo: string;
    env: NodeJS.ProcessEnv;
    out: (s: string) => void;
  },
): Promise<number> {
  const issue = Number(args[0]);
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('退回命令缺少规范单号');
  const dir = runDir(runsRoot(o.env), o.repo, issue);
  const f = runFiles(dir);
  const spec = readJson<RunSpec>(f.spec);
  const state = readJson<RunStatus>(f.state);
  if (!spec || !state || spec.repo !== o.repo || spec.issue !== issue || !state.sessionId)
    throw new Error('没有可核实的受管运行/会话');
  const pr = await managedPr(o.gh, spec.branch);
  const api = feedbackApi(o.gh, o.repo);
  if (action === 'deliver') {
    const { records } = await readManagedFeedbackForGate(api, pr.number, pr.headRefOid);
    if (readJson<FeedbackEvent>(join(dir, 'feedback-intent.json'))) {
      const intent = readJson<FeedbackEvent>(join(dir, 'feedback-intent.json'));
      const snapshot = await readManagedFeedback(api, pr.number, pr.headRefOid);
      if (
        !snapshot.reviews.some(
          (r) =>
            r.user.id === snapshot.source.writerId &&
            !!parseFeedback(r.body) &&
            sameFeedbackRequest(parseFeedback(r.body) as FeedbackEvent, intent as FeedbackEvent),
        )
      )
        throw new Error('退回事务仍未确认，不能交付');
    }
    if (records.some((r) => !r.resolved)) throw new Error('存在未解决退回，不能ready或挂自动合并');
    if (pr.isDraft) throw new Error('PR仍为草稿；审查方须明确解除草稿原因后再交付');
    const armed = await o.gh([
      'pr',
      'merge',
      String(pr.number),
      '--auto',
      '--squash',
      '--match-head-commit',
      pr.headRefOid,
    ]);
    if (armed.code !== 0) throw new Error(`受管交付失败：${armed.stderr || armed.stdout}`);
    o.out('已为精确head申请squash自动合并；尚未代表完成。');
    return 0;
  }
  const { source, records, reviews } = await readManagedFeedback(api, pr.number, pr.headRefOid);
  const intentFile = join(dir, 'feedback-intent.json');
  if (action === 'feedback' && args.includes('--retry')) {
    const intent = readJson<FeedbackEvent>(intentFile);
    if (!intent) throw new Error('没有可重试事务');
    if (o.env.FLEET_WORKER === '1' && intent.action !== 'ack')
      throw new Error('工人不能代审查方重发退回或解决');
    await api.post('/actions/workflows/managed-feedback.yml/dispatches', {
      ref: 'main',
      inputs: {
        pr: String(intent.pr),
        feedback: JSON.stringify(intent),
        'request-id': intent.requestId,
      },
    });
    return managedWorkUnlocked('feedback', [String(issue), '--wait'], o);
  }
  if (action === 'feedback' && args.includes('--wait')) {
    const intent = readJson<FeedbackEvent>(intentFile);
    if (!intent) throw new Error('没有需要等待的本机事务');
    const runs = await o.gh([
      'run',
      'list',
      '--workflow',
      'managed-feedback.yml',
      '--event',
      'workflow_dispatch',
      '--json',
      'databaseId,displayTitle',
      '--limit',
      '100',
    ]);
    if (runs.code !== 0) throw new Error('退回事务Actions队列未读成');
    const found = JSON.parse(runs.stdout).find(
      (r: { displayTitle: string }) => r.displayTitle === `managed-feedback ${intent.requestId}`,
    );
    if (!found) {
      o.out(`queued/unconfirmed：${intent.requestId}，Actions尚无可核实回执；意图保留。`);
      return 2;
    }
    const watched = await o.gh(['run', 'watch', String(found.databaseId), '--exit-status']);
    if (watched.code !== 0) throw new Error('退回事务被取消/超时/失败；意图保留，不能算阻合成功');
    return managedWorkUnlocked(
      'feedback',
      args.filter((a) => a !== '--wait'),
      o,
    );
  }
  if (action === 'feedback') {
    o.out(JSON.stringify({ pr: pr.number, head: pr.headRefOid, records }, null, 2));
    const intent = readJson<FeedbackEvent>(intentFile);
    if (intent) {
      const receipt = reviews.find(
        (r) =>
          r.user.id === source.writerId &&
          !!parseFeedback(r.body) &&
          sameFeedbackRequest(parseFeedback(r.body) as FeedbackEvent, intent),
      );
      if (!receipt) {
        o.out(`queued/unconfirmed：${intent.requestId}，不能声称已阻止交付`);
        return 2;
      }
      if (pr.mergedAt) {
        o.out(`late：review #${receipt.id}，PR已合并，不能声称已阻止交付。`);
        return 1;
      }
      const statuses = await api.get(`/commits/${pr.headRefOid}/statuses?per_page=100&page=1`);
      if (!Array.isArray(statuses)) throw new Error('真实阻合状态未读成');
      const latest = statuses.find((s) => s?.context === 'merge-gate');
      if (records.some((r) => !r.resolved)) {
        if (
          !latest ||
          !['failure', 'pending'].includes(latest.state) ||
          latest.creator?.id !== source.writerId
        )
          throw new Error('review已登记，但当前head阻合状态未核实；保留未知责任');
        o.out(
          `registered/blocked：review #${receipt.id}，当前head真实merge-gate ${latest.state}；ack不等于resolve。`,
        );
      } else o.out(`registered：review #${receipt.id}；本机退回责任已解除，交付仍须其余闸通过。`);
    }
    return 0;
  }
  const actorResult = await o.gh(['api', '/user']);
  if (actorResult.code !== 0) throw new Error('真实发起者身份未查成');
  const actor = JSON.parse(actorResult.stdout);
  if (actor.id !== source.dispatcherId || actor.type !== 'User') throw new Error('退回事务目前仅授权仓owner');
  if (action !== 'ack' && o.env.FLEET_WORKER === '1') throw new Error('受管工人不能替审查方退回或解决意见');
  if (
    action === 'ack' &&
    (o.env.FLEET_WORK_RUN !== spec.createdAt || o.env.FLEET_WORK_SESSION !== state.sessionId)
  )
    throw new Error('消费回执不属于当前受管run/session');
  const flag = (name: string) => {
    const n = args.indexOf(name);
    return n < 0 ? undefined : args[n + 1];
  };
  const textFile = flag('--body-file');
  const text = textFile ? readFileSync(textFile, 'utf8') : undefined;
  const target = flag('--return');
  const prior = target ? records.find((r) => r.event.returnId === target) : undefined;
  if (action !== 'return' && !prior) throw new Error('ack/resolve必须指定真实 --return 编号');
  if (action === 'return' && !text?.trim()) throw new Error('退回必须带完整 --body-file 意见');
  if (action === 'resolve' && !text?.trim()) throw new Error('解决意见必须带 --body-file 核验依据');
  const requestId = randomUUID();
  const event: FeedbackEvent = {
    v: 1,
    action: action as FeedbackEvent['action'],
    repoId: source.repoId,
    repo: source.repo,
    issue,
    pr: pr.number,
    run: spec.createdAt,
    session: state.sessionId,
    requestId,
    returnId: prior?.event.returnId ?? requestId,
    generation: prior?.event.generation ?? Math.max(0, ...records.map((r) => r.event.generation)) + 1,
    head: action === 'ack' ? (prior?.event.head ?? pr.headRefOid) : pr.headRefOid,
    digest: prior?.event.digest ?? feedbackDigest(text ?? ''),
    text: text ?? prior?.event.text ?? '',
    dispatcherId: source.dispatcherId,
  };
  const old = readJson<FeedbackEvent>(intentFile);
  if (
    old &&
    !reviews.some(
      (r) =>
        r.user.id === source.writerId &&
        !!parseFeedback(r.body) &&
        sameFeedbackRequest(parseFeedback(r.body) as FeedbackEvent, old),
    )
  )
    throw new Error(`旧事务 ${old.requestId} 未确认；先 feedback 核回执，不覆盖未知责任`);
  writeJson(intentFile, event);
  await api.post('/actions/workflows/managed-feedback.yml/dispatches', {
    ref: 'main',
    inputs: {
      pr: String(pr.number),
      feedback: JSON.stringify(event),
      'request-id': requestId,
    },
  });
  o.out(`queued：${requestId}；尚未核实真实阻合和review回执，用 pnpm work feedback ${issue} 取回执。`);
  return managedWorkUnlocked('feedback', [String(issue), '--wait'], o);
}

export async function managedFeedbackContext(gh: Gh, spec: RunSpec): Promise<string> {
  const listed = await gh([
    'pr',
    'list',
    '--head',
    spec.branch,
    '--state',
    'all',
    '--json',
    'number',
    '--limit',
    '100',
  ]);
  if (listed.code !== 0) throw new Error('恢复前受管PR未读成');
  const list: unknown = JSON.parse(listed.stdout);
  if (!Array.isArray(list)) throw new Error('恢复前受管PR列表认不出');
  if (list.length === 0) return '本分支尚无PR，交付前必须 pnpm work feedback 读取退回。';
  const pr = await managedPr(gh, spec.branch);
  const { records } = await readManagedFeedbackForGate(feedbackApi(gh, spec.repo), pr.number, pr.headRefOid);
  return `完整本机审查退回（ack仅确认收到，不能解除）：\n${JSON.stringify(records, null, 2)}\n交付前运行 pnpm work feedback ${spec.issue}，禁止根据旧CI或draft猜测退回已消失。`;
}

export async function managedWork(
  action: string,
  args: readonly string[],
  o: Parameters<typeof managedWorkUnlocked>[2],
): Promise<number> {
  const issue = Number(args[0]);
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('单号不是正安全整数');
  const dir = runDir(runsRoot(o.env), o.repo, issue);
  if (!existsSync(runFiles(dir).spec)) throw new Error('没有受管运行记录');
  const lock = join(dir, 'feedback-lock');
  try {
    mkdirSync(lock);
  } catch {
    const owner = readJson<{ pid: number }>(join(lock, 'owner.json'));
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1)
      throw new Error('反馈锁归属未知，不能清除');
    let dead = false;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      dead = (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (!dead) throw new Error('同run反馈操作仍在执行，不能覆盖并发意图');
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
  }
  writeJson(join(lock, 'owner.json'), { pid: process.pid });
  try {
    return await managedWorkUnlocked(action, args, o);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function managedCloseGate(gh: Gh, repoUrl: string, issue: number): Promise<void> {
  const repo = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)$/.exec(repoUrl)?.[1];
  if (!repo) throw new Error('本机关单仓身份认不出');
  const spec = readJson<RunSpec>(runFiles(runDir(runsRoot(), repo, issue)).spec);
  if (spec) await validateManagedDelivery(gh, spec, false);
}
