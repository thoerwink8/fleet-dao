import type { GhApi } from './gh-api.ts';
import {
  type FeedbackEvent,
  type FeedbackReview,
  feedbackBody,
  feedbackRecords,
  parseFeedback,
  parsePrepare,
  prepareBody,
  sameFeedbackRequest,
} from './managed-feedback.ts';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export async function feedbackSource(api: GhApi) {
  const repo = await api.get('');
  if (
    !object(repo) ||
    !Number.isSafeInteger(repo.id) ||
    typeof repo.full_name !== 'string' ||
    !object(repo.owner) ||
    repo.owner.type !== 'User' ||
    !Number.isSafeInteger(repo.owner.id)
  )
    throw new Error('本机退回目前只支持数字 owner 身份可核实的个人仓');
  if (!api.globalGet) throw new Error('退回 writer 身份读口未装配');
  const bot = await api.globalGet('/users/github-actions%5Bbot%5D');
  if (
    !object(bot) ||
    bot.type !== 'Bot' ||
    bot.login !== 'github-actions[bot]' ||
    !Number.isSafeInteger(bot.id)
  )
    throw new Error('Actions Bot 数字身份未核实');
  return {
    repoId: repo.id as number,
    repo: repo.full_name,
    dispatcherId: repo.owner.id as number,
    writerId: bot.id as number,
  };
}
export async function feedbackReviews(api: GhApi, pr: number): Promise<FeedbackReview[]> {
  const all: FeedbackReview[] = [];
  for (let page = 1; page <= 100; page++) {
    const values = await api.get(`/pulls/${pr}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(values)) throw new Error('退回 review 列表认不出');
    for (const r of values) {
      if (
        !object(r) ||
        !Number.isSafeInteger(r.id) ||
        !object(r.user) ||
        !Number.isSafeInteger(r.user.id) ||
        typeof r.user.type !== 'string' ||
        typeof r.body !== 'string' ||
        typeof r.state !== 'string' ||
        typeof r.commit_id !== 'string'
      )
        throw new Error('退回 review 身份或正文认不出');
      all.push(r as unknown as FeedbackReview);
    }
    if (values.length < 100) return all;
  }
  throw new Error('退回 review 超过分页上限，未读全');
}
export async function readManagedFeedback(api: GhApi, pr: number, head: string) {
  const source = await feedbackSource(api);
  const reviews = await feedbackReviews(api, pr);
  for (const review of reviews.filter(
    (r) => r.user.id === source.writerId && r.user.type === 'Bot' && r.state === 'COMMENTED',
  )) {
    const prepare = parsePrepare(review.body);
    if (!prepare) continue;
    const e = prepare.request;
    if (
      e.repoId !== source.repoId ||
      e.repo.toLowerCase() !== source.repo.toLowerCase() ||
      e.pr !== pr ||
      e.dispatcherId !== source.dispatcherId ||
      review.commit_id !== prepare.preparedHead
    )
      throw new Error('prepare真实来源/仓/PR/head不匹配');
  }
  return {
    source,
    reviews,
    records: feedbackRecords(reviews, { ...source, pr }, source.writerId, source.dispatcherId, head),
  };
}
/** 必须在 merge-gate 的精确 PR concurrency 内执行；本函数不假造跨 API 的原子事务。 */
export async function transactFeedback(api: GhApi, pr: number, request: FeedbackEvent, actorId: number) {
  // 先严格解析完整请求，正文不执行为代码或命令。
  parseFeedback(feedbackBody(request));
  if (request.publishedHead !== undefined) throw new Error('请求不能自报正式回执发表头');
  const live = await api.get(`/pulls/${pr}`);
  if (!object(live) || !object(live.head) || !object(live.base) || !object(live.base.repo))
    throw new Error('PR身份未查成');
  const currentHead = live.head.sha;
  if (
    typeof currentHead !== 'string' ||
    !/^[a-f0-9]{40}$/.test(currentHead) ||
    typeof live.head.ref !== 'string' ||
    !live.head.ref.startsWith(`local/${request.issue}-`)
  )
    throw new Error('不是对应单的本机受管 PR');
  if (live.merged === true) return { state: 'late' as const, requestId: request.requestId };
  if (live.state !== 'open') throw new Error('PR已关闭但未合并');
  const { source, reviews, records } = await readManagedFeedback(api, pr, currentHead);
  if (
    actorId !== source.dispatcherId ||
    request.dispatcherId !== actorId ||
    request.repoId !== source.repoId ||
    request.repo.toLowerCase() !== source.repo.toLowerCase() ||
    request.pr !== pr ||
    live.base.repo.id !== source.repoId
  )
    throw new Error('退回请求未获得仓 owner 数字身份授权');
  const existing = reviews
    .filter((r) => r.user.id === source.writerId && r.state === 'COMMENTED')
    .find((r) => parseFeedback(r.body)?.requestId === request.requestId);
  if (existing && !sameFeedbackRequest(parseFeedback(existing.body) as FeedbackEvent, request))
    throw new Error('requestId已被不同正文使用');
  const otherPending = reviews
    .filter((r) => r.user.id === source.writerId && r.state === 'COMMENTED')
    .map((r) => parsePrepare(r.body))
    .find(
      (p) =>
        p &&
        p.request.requestId !== request.requestId &&
        !reviews.some(
          (r) =>
            r.user.id === source.writerId &&
            r.state === 'COMMENTED' &&
            !!parseFeedback(r.body) &&
            sameFeedbackRequest(parseFeedback(r.body) as FeedbackEvent, p.request),
        ),
    );
  if (otherPending) throw new Error('另有未完成prepare，先恢复同requestId');
  let prepared = reviews.find(
    (r) =>
      r.user.id === source.writerId &&
      r.state === 'COMMENTED' &&
      parsePrepare(r.body)?.request.requestId === request.requestId,
  );
  if (prepared && !sameFeedbackRequest(parsePrepare(prepared.body)?.request ?? request, request))
    throw new Error('prepare requestId已被不同正文使用');
  if (!existing && !prepared && request.action === 'return') {
    if (request.head !== currentHead) throw new Error('退回 head 已过期，保留意图并重新核实');
    if (request.generation !== Math.max(0, ...records.map((r) => r.event.generation)) + 1)
      throw new Error('退回代次已过期');
  } else if (!existing && request.action !== 'return') {
    // 用真实 reducer 验证 ack/resolve；不能把 ack 当 resolve。
    feedbackRecords(
      [
        ...reviews,
        {
          id: Math.max(0, ...reviews.map((r) => r.id)) + 1,
          user: { id: source.writerId, type: 'Bot' },
          state: 'COMMENTED',
          commit_id: request.head,
          body: feedbackBody(request),
        },
      ],
      { ...source, pr },
      source.writerId,
      source.dispatcherId,
      currentHead,
    );
    if (!prepared && request.action === 'resolve' && request.head !== currentHead)
      throw new Error('解决意见的候选 head 已过期');
  }
  // 先把明确prepare持久到PR；未收到此回执时不声称已阻合。
  if (!prepared && !existing) {
    const body = prepareBody(request, currentHead);
    try {
      await api.post(`/pulls/${pr}/reviews`, { event: 'COMMENT', commit_id: currentHead, body });
    } catch {
      /* 回执丢失按原request找回 */
    }
    prepared = (await feedbackReviews(api, pr)).find(
      (r) => r.user.id === source.writerId && r.state === 'COMMENTED' && r.body === body,
    );
    if (!prepared) {
      const missed = await api.get(`/pulls/${pr}`);
      if (object(missed) && missed.merged === true)
        return { state: 'late' as const, requestId: request.requestId };
      throw new Error('prepare未持久核实；本机意图保留，尚未阻合');
    }
  }
  const before = await api.get(`/pulls/${pr}`);
  if (!object(before) || !object(before.head)) throw new Error('prepare后PR未核实');
  if (before.merged === true) return { state: 'late' as const, requestId: request.requestId };
  if (before.state !== 'open' || before.head.sha !== currentHead)
    throw new Error('prepare后head改变；PR级责任保留，重试同requestId');
  // 真正required阻合状态必须在正式回执前写入并回读；prepare本身不冒称blocked。
  await api.post(`/statuses/${currentHead}`, {
    state: 'pending',
    context: 'merge-gate',
    description: `fleet-managed-feedback:${request.requestId} 等待review回执`,
  });
  const statuses = await api.get(`/commits/${currentHead}/statuses?per_page=100&page=1`);
  const latest = Array.isArray(statuses)
    ? statuses.find((s) => object(s) && s.context === 'merge-gate')
    : undefined;
  if (
    !object(latest) ||
    latest.state !== 'pending' ||
    !object(latest.creator) ||
    latest.creator.id !== source.writerId
  )
    throw new Error('当前head的最新阻合状态/写者未核实，保留未确认意图');
  const published = { ...request, publishedHead: currentHead };
  try {
    if (!existing)
      await api.post(`/pulls/${pr}/reviews`, {
        event: 'COMMENT',
        commit_id: currentHead,
        body: feedbackBody(published),
      });
  } catch {
    // POST可能成功但回执丢失；只按同requestId真读找回，不盲目重复发表。
  }
  const after = await readManagedFeedback(api, pr, currentHead);
  const receipt = after.reviews.find(
    (r) =>
      r.user.id === source.writerId &&
      r.state === 'COMMENTED' &&
      !!parseFeedback(r.body) &&
      sameFeedbackRequest(parseFeedback(r.body) as FeedbackEvent, request),
  );
  if (!receipt) throw new Error('退回回执未核实，保留未确认意图');
  const final = await api.get(`/pulls/${pr}`);
  if (!object(final) || !object(final.head)) throw new Error('事务后PR未核实');
  if (final.merged === true)
    return { state: 'late' as const, requestId: request.requestId, reviewId: receipt.id };
  if (final.state !== 'open' || final.head.sha !== currentHead)
    throw new Error('事务期间head或状态改变，责任仍保留');
  return { state: 'registered' as const, requestId: request.requestId, reviewId: receipt.id };
}

/** 无协议时保留普通local分支/组织仓既有判法，不引入owner限制。 */
export async function readManagedFeedbackForGate(api: GhApi, pr: number, head: string) {
  const reviews = await feedbackReviews(api, pr);
  const marked = (r: FeedbackReview) =>
    r.body.startsWith('<!-- fleet-managed-feedback:v1 -->') ||
    r.body.startsWith('<!-- fleet-managed-feedback-prepare:v1 -->');
  if (!reviews.some((r) => r.user.type === 'Bot' && marked(r))) return { records: [] };
  if (!api.globalGet) throw new Error('Actions身份读口未装配');
  const bot = await api.globalGet('/users/github-actions%5Bbot%5D');
  if (!object(bot) || bot.type !== 'Bot' || !Number.isSafeInteger(bot.id))
    throw new Error('Actions数字身份未核实');
  if (!reviews.some((r) => r.user.id === bot.id && r.user.type === 'Bot' && marked(r)))
    return { records: [] };
  const snapshot = await readManagedFeedback(api, pr, head);
  for (const r of snapshot.reviews.filter(
    (r) => r.user.id === snapshot.source.writerId && r.state === 'COMMENTED',
  )) {
    const prep = parsePrepare(r.body);
    if (!prep) continue;
    const receipt = snapshot.reviews.some(
      (formal) =>
        formal.user.id === snapshot.source.writerId &&
        formal.state === 'COMMENTED' &&
        !!parseFeedback(formal.body) &&
        sameFeedbackRequest(parseFeedback(formal.body) as FeedbackEvent, prep.request),
    );
    if (!receipt) throw new Error(`prepare ${prep.request.requestId} 未核实正式回执；所有head保留责任`);
  }
  return snapshot;
}
