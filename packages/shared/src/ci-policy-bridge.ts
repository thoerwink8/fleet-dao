// 零依赖协议：source 只认证当前数据库的读口，永远不携带可授权的模式快照。
export const CI_POLICY_SOURCE_PREFIX = 'fleet-ci-policy-source/pr/';
export const CI_POLICY_BRIDGE_VERSION = 1;
export const CI_POLICY_BRIDGE_PATH = '/api/public/ci-policy/v1/repos';
/** 机器只读协议，独立于浏览器 FleetApi；不提供公开写口。 */
export const PublicCiPolicyRoute = { method: 'GET', path: `${CI_POLICY_BRIDGE_PATH}/:githubId` } as const;

export interface PolicyRepo {
  githubId: number;
  repo: string;
  public: boolean;
}
export interface PolicyHead {
  number: number;
  head: string;
  open: boolean;
  fork: boolean;
}
export interface PolicyResponse {
  version: 1;
  githubId: number;
  repo: string;
  ciPolicy: 'force' | 'off';
}
export interface PolicyBridgeDescriptor {
  version: 1;
  endpoint: string | null;
  publisher: boolean;
  public: boolean;
}

export function policyRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
export function policyId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}
/** 同 SHA 可有多张 PR，来源的状态名也必须逐 PR 隔离。 */
export function policySourceContext(number: number): string {
  if (!policyId(number)) throw new Error('source PR 号认不出');
  return `${CI_POLICY_SOURCE_PREFIX}${number}`;
}
export function policySourceNumber(context: unknown): number | null {
  if (typeof context !== 'string' || !context.startsWith(CI_POLICY_SOURCE_PREFIX)) return null;
  const tail = context.slice(CI_POLICY_SOURCE_PREFIX.length);
  const number = Number(tail);
  return /^[1-9]\d*$/.test(tail) && policyId(number) && policySourceContext(number) === context
    ? number
    : null;
}
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
export function policyRepo(raw: unknown): PolicyRepo {
  if (
    !policyRecord(raw) ||
    !policyId(raw.id) ||
    typeof raw.full_name !== 'string' ||
    !SLUG.test(raw.full_name) ||
    typeof raw.private !== 'boolean'
  )
    throw new Error('GitHub 仓身份或 public/private 未查成');
  return { githubId: raw.id, repo: raw.full_name, public: raw.private === false };
}
export function policyHead(raw: unknown, repo: PolicyRepo): PolicyHead {
  if (
    !policyRecord(raw) ||
    !policyId(raw.number) ||
    !policyRecord(raw.head) ||
    !policyRecord(raw.base) ||
    !policyRecord(raw.base.repo) ||
    raw.base.repo.id !== repo.githubId ||
    typeof raw.base.repo.full_name !== 'string' ||
    raw.base.repo.full_name.toLowerCase() !== repo.repo.toLowerCase() ||
    typeof raw.head.sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(raw.head.sha) ||
    (raw.state !== 'open' && raw.state !== 'closed')
  )
    throw new Error('PR 的仓号、当前 head 或状态未查成');
  const headRepo = raw.head.repo;
  if (
    headRepo !== null &&
    (!policyRecord(headRepo) ||
      !policyId(headRepo.id) ||
      typeof headRepo.full_name !== 'string' ||
      !SLUG.test(headRepo.full_name))
  )
    throw new Error('PR head 仓身份未查成');
  return {
    number: raw.number,
    head: raw.head.sha,
    open: raw.state === 'open',
    fork:
      headRepo === null ||
      headRepo.id !== repo.githubId ||
      (headRepo.full_name as string).toLowerCase() !== repo.repo.toLowerCase(),
  };
}

export function policyOrigin(value: string): URL {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    u.pathname !== '/' ||
    u.search ||
    u.hash ||
    u.origin !== value.replace(/\/$/, '')
  )
    throw new Error('CI 策略读口必须是规范 HTTPS origin（无凭据、端口、路径）');
  return u;
}
export function policyEndpoint(origin: string, githubId: number): string {
  if (!policyId(githubId)) throw new Error('CI 策略读口仓号认不出');
  return `${policyOrigin(origin).origin}${CI_POLICY_BRIDGE_PATH}/${githubId}`;
}
export function policySourceUrl(endpoint: string, head: PolicyHead): string {
  if (!policyId(head.number) || !/^[a-f0-9]{40}$/.test(head.head)) throw new Error('source head 认不出');
  return `${endpoint}?pr=${head.number}&head=${head.head}`;
}
export function parsePolicyUrl(value: unknown, githubId: number, head?: PolicyHead): string {
  if (typeof value !== 'string') throw new Error('source 缺 HTTPS 读口');
  const u = new URL(value);
  const endpoint = policyEndpoint(u.origin, githubId);
  const want = head ? policySourceUrl(endpoint, head) : endpoint;
  if (value !== want || u.username || u.password || u.hash || u.port)
    throw new Error('source URL 的协议、仓号、PR/head 或参数不匹配');
  return value;
}
export function parsePolicyResponse(
  raw: unknown,
  repo: Pick<PolicyRepo, 'githubId' | 'repo'>,
): PolicyResponse {
  if (
    !policyRecord(raw) ||
    Object.keys(raw).sort().join(',') !== 'ciPolicy,githubId,repo,version' ||
    raw.version !== CI_POLICY_BRIDGE_VERSION ||
    raw.githubId !== repo.githubId ||
    typeof raw.repo !== 'string' ||
    raw.repo.toLowerCase() !== repo.repo.toLowerCase() ||
    (raw.ciPolicy !== 'force' && raw.ciPolicy !== 'off')
  )
    throw new Error('CI 策略桥响应的协议、仓身份或模式不匹配');
  return raw as unknown as PolicyResponse;
}

/** 传入完整的新到旧逐条 statuses。最新可信条坏了不能回退；其它 creator 不能提供读口。 */
export function latestPolicyStatus(
  list: unknown[],
  repo: PolicyRepo,
  head: string,
  writerId: number,
  context: string,
  apiOrigin = 'https://api.github.com',
): Record<string, unknown> | null {
  if (!policyId(writerId)) throw new Error('可信 writer 数字身份未查成');
  let latest: Record<string, unknown> | null = null;
  const ids = new Set<number>();
  for (const raw of list) {
    if (!policyRecord(raw)) throw new Error('逐条 status 不是对象');
    if (raw.context !== context) continue;
    if (!policyRecord(raw.creator) || !policyId(raw.creator.id) || typeof raw.creator.type !== 'string')
      throw new Error('source status 缺 creator 数字身份');
    if (raw.creator.id !== writerId || raw.creator.type !== 'Bot') continue;
    if (!policyId(raw.id) || ids.has(raw.id)) throw new Error('可信 status 编号缺失或重复');
    ids.add(raw.id);
    latest ??= raw;
  }
  if (latest) {
    const expected = `${apiOrigin}/repos/${repo.repo}/statuses/${head}`;
    if (typeof latest.url !== 'string' || latest.url.toLowerCase() !== expected.toLowerCase())
      throw new Error('可信 status URL 的仓或 SHA 对不上');
    if (!['success', 'pending', 'failure', 'error'].includes(String(latest.state)))
      throw new Error('可信 status 状态认不出');
  }
  return latest;
}
