// 本机受管工人的显式退回协议；普通评论和法国正式 CR 不在此协议内。
import { createHash } from 'node:crypto';

export const FEEDBACK_MARKER = '<!-- fleet-managed-feedback:v1 -->';
export const PREPARE_MARKER = '<!-- fleet-managed-feedback-prepare:v1 -->';
export interface FeedbackIdentity {
  repoId: number;
  repo: string;
  issue: number;
  pr: number;
  run: string;
  session: string;
}
export interface FeedbackEvent extends FeedbackIdentity {
  v: 1;
  action: 'return' | 'ack' | 'resolve';
  requestId: string;
  returnId: string;
  generation: number;
  head: string;
  digest: string;
  text: string;
  dispatcherId: number;
  /** 正式回执发表时的PR头；head仍是原意见/候选头。 */
  publishedHead?: string;
}
export interface FeedbackReview {
  id: number;
  user: { id: number; type: string };
  state: string;
  commit_id: string;
  body: string;
}
export const feedbackDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
export function feedbackBody(event: FeedbackEvent): string {
  return `${FEEDBACK_MARKER}\n${JSON.stringify(event)}\n`;
}
export function parseFeedback(body: string): FeedbackEvent | null {
  if (!body.startsWith(FEEDBACK_MARKER)) return null;
  const value: unknown = JSON.parse(body.slice(FEEDBACK_MARKER.length).trim());
  if (!value || typeof value !== 'object') throw new Error('退回协议不是对象');
  const e = value as FeedbackEvent;
  if (e.publishedHead !== undefined && !/^[a-f0-9]{40}$/.test(e.publishedHead))
    throw new Error('回执发表头认不出');
  if (
    e.v !== 1 ||
    !['return', 'ack', 'resolve'].includes(e.action) ||
    ![e.repoId, e.issue, e.pr, e.generation, e.dispatcherId].every((n) => Number.isSafeInteger(n) && n > 0) ||
    !/^[\w.-]+\/[\w.-]+$/.test(e.repo) ||
    ![e.requestId, e.returnId, e.run, e.session].every(
      (s) => typeof s === 'string' && s.length > 0 && s.length < 200,
    ) ||
    !/^[a-f0-9]{40}$/.test(e.head) ||
    !/^[a-f0-9]{64}$/.test(e.digest) ||
    typeof e.text !== 'string' ||
    !e.text.trim() ||
    e.text.length > 30000 ||
    (e.action === 'return' && feedbackDigest(e.text) !== e.digest)
  )
    throw new Error('退回协议字段或摘要不匹配');
  return e;
}
export interface FeedbackRecord {
  reviewId: number;
  event: FeedbackEvent;
  ack: boolean;
  resolved: boolean;
}
/** 只接受可信单写者发表的 COMMENTED review。信任数字身份由装配选择，不读评论自称。 */
export function feedbackRecords(
  reviews: FeedbackReview[],
  identity: Pick<FeedbackIdentity, 'repoId' | 'repo' | 'pr'>,
  writerId: number,
  dispatcherId: number,
  candidateHead: string,
): FeedbackRecord[] {
  const records = new Map<string, FeedbackRecord>();
  const requests = new Map<string, string>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (review.user.id !== writerId || review.user.type !== 'Bot' || review.state !== 'COMMENTED') continue;
    const e = parseFeedback(review.body);
    if (!e) continue;
    if (
      e.repoId !== identity.repoId ||
      e.repo.toLowerCase() !== identity.repo.toLowerCase() ||
      e.pr !== identity.pr ||
      e.dispatcherId !== dispatcherId ||
      review.commit_id !== (e.publishedHead ?? e.head)
    )
      throw new Error('退回来源或仓/PR身份不匹配');
    const serialized = JSON.stringify(e);
    const previous = requests.get(e.requestId);
    if (previous && previous !== serialized) throw new Error('同一请求出现不同回执');
    if (previous) continue;
    requests.set(e.requestId, serialized);
    if (e.action === 'return') {
      if (records.has(e.returnId)) throw new Error('退回编号重复');
      const max = Math.max(0, ...[...records.values()].map((r) => r.event.generation));
      if (e.generation !== max + 1) throw new Error('退回代次不连续');
      records.set(e.returnId, { reviewId: review.id, event: e, ack: false, resolved: false });
      continue;
    }
    const r = records.get(e.returnId);
    if (
      !r ||
      r.event.generation !== e.generation ||
      r.event.digest !== e.digest ||
      r.event.run !== e.run ||
      r.event.session !== e.session ||
      r.event.issue !== e.issue
    )
      throw new Error('回执引用旧代次或错误运行/会话');
    if (e.action === 'ack') {
      if (e.head !== r.event.head) throw new Error('消费回执的审查头不匹配');
      r.ack = true;
    } else {
      if (!r.ack) throw new Error('未确认收到完整意见，不能解决');
      // resolve 只在明确审查的候选头有效；换头必须重新解决。
      r.resolved = e.head === candidateHead;
    }
  }
  return [...records.values()];
}

export function prepareBody(request: FeedbackEvent, preparedHead: string): string {
  return `${PREPARE_MARKER}\n${JSON.stringify({ v: 1, phase: 'prepare', preparedHead, request })}\n`;
}
export function parsePrepare(body: string): { preparedHead: string; request: FeedbackEvent } | null {
  if (!body.startsWith(PREPARE_MARKER)) return null;
  const v = JSON.parse(body.slice(PREPARE_MARKER.length).trim());
  if (v?.v !== 1 || v.phase !== 'prepare' || !/^[a-f0-9]{40}$/.test(v.preparedHead))
    throw new Error('prepare协议字段认不出');
  const request = parseFeedback(feedbackBody(v.request));
  if (!request || request.publishedHead !== undefined) throw new Error('prepare请求不能冒充正式回执');
  return { preparedHead: v.preparedHead, request };
}
export function sameFeedbackRequest(a: FeedbackEvent, b: FeedbackEvent): boolean {
  const { publishedHead: _a, ...left } = a;
  const { publishedHead: _b, ...right } = b;
  return feedbackBody(left) === feedbackBody(right);
}
