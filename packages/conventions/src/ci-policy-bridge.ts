// Actions 的零安装真实读桥；协议 import 也只能走零依赖文件。
import { readFileSync } from 'node:fs';
import {
  latestPolicyStatus,
  type PolicyRepo,
  type PolicyResponse,
  parsePolicyResponse,
  parsePolicyUrl,
  policyHead,
  policyId,
  policyRecord,
  policyRepo,
  policySourceContext,
} from '../../shared/src/ci-policy-bridge.ts';
import type { GhApi } from './gh-api.ts';
import type { GitHubReads } from './merge-gate.ts';

export async function readPolicyHttp(
  url: string,
  repo: Pick<PolicyRepo, 'githubId' | 'repo'>,
  fetchImpl: typeof fetch = fetch,
): Promise<PolicyResponse> {
  const init: RequestInit & { cache: 'no-store' } = {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    headers: { accept: 'application/json', 'cache-control': 'no-cache, no-store' },
    signal: AbortSignal.timeout(10_000),
  };
  const res = await fetchImpl(url, init);
  if (
    res.status !== 200 ||
    res.redirected ||
    !/^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type') ?? '')
  )
    throw new Error(`CI 策略桥未读成（HTTP ${res.status} 或非 JSON/重定向）`);
  if (!(res.headers.get('cache-control') ?? '').split(',').some((x) => x.trim().toLowerCase() === 'no-store'))
    throw new Error('CI 策略桥没有禁止缓存');
  if (!res.body) throw new Error('CI 策略桥没有响应体');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error('CI 策略桥响应超过 4096 字节');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return parsePolicyResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), repo);
}

/** writer slug 只从可信标准检出读取，不从 caller 或 source 接收。 */
export function trustedEngineLogin(): string {
  const raw: unknown = JSON.parse(readFileSync(new URL('../github-apps.json', import.meta.url), 'utf8'));
  if (
    !policyRecord(raw) ||
    !policyRecord(raw.apps) ||
    !policyRecord(raw.apps.engine) ||
    typeof raw.apps.engine.slug !== 'string' ||
    !/^[a-z0-9-]+$/.test(raw.apps.engine.slug)
  )
    throw new Error('标准 engine App 配置认不出');
  return `${raw.apps.engine.slug}[bot]`;
}

export function policyReader(api: GhApi, gh: GitHubReads, slug: string, fetchImpl: typeof fetch = fetch) {
  return async (number: number, expectedHead: string): Promise<'force' | 'off'> => {
    const repo = policyRepo(await api.get(''));
    if (repo.repo.toLowerCase() !== slug.toLowerCase()) throw new Error('GitHub 实际仓身份不匹配');
    // 私有仓沿原强制路径；绝不跟随它曾公开时留下的来源 URL。
    if (!repo.public) return 'force';
    const head = policyHead(await gh.pr(number), repo);
    if (head.number !== number || head.head !== expectedHead || !head.open)
      throw new Error('PR 当前 head 已改变');
    const statuses = await gh.statuses(head.head);
    const context = policySourceContext(number);
    // 缺来源保留旧 force；出现来源以后任何不可验证材料均明确失败。
    if (!statuses.some((s) => policyRecord(s) && s.context === context)) return 'force';
    if (!api.globalGet) throw new Error('GitHub writer 身份 reader 未装配');
    const login = trustedEngineLogin();
    const bot = await api.globalGet(`/users/${encodeURIComponent(login)}`);
    if (!policyRecord(bot) || !policyId(bot.id) || bot.type !== 'Bot' || bot.login !== login)
      throw new Error('可信 Bot 数字身份未查成');
    const source = latestPolicyStatus(statuses, repo, head.head, bot.id, context);
    if (!source) throw new Error('没有可信 engine writer 的 source');
    if (head.fork || source.state !== 'success') throw new Error('source 不是公开同仓当前头的可用读口');
    const url = parsePolicyUrl(source.target_url, repo.githubId, head);
    return (await readPolicyHttp(url, repo, fetchImpl)).ciPolicy;
  };
}
