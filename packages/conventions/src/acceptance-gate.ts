import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  latestPolicyStatus,
  parsePolicyUrl,
  policyHead,
  policyOrigin,
  policyRecord,
  policyRepo,
  policySourceContext,
} from '../../shared/src/ci-policy-bridge.ts';
import { trustedEngineLogin } from './ci-policy-bridge.ts';
import type { Gh } from './issue-new.ts';

export function acceptanceOrigin(): string {
  let value = process.env.FLEET_PUBLIC_URL;
  if (!value) {
    if (process.env.GITHUB_ACTIONS === 'true')
      throw new Error('Actions 未装配 FLEET_PUBLIC_URL 验收责任读口');
    const config: unknown = JSON.parse(
      readFileSync(join(homedir(), '.fleet-dao', 'local-sessions', 'config.json'), 'utf8'),
    );
    if (!policyRecord(config) || typeof config.url !== 'string')
      throw new Error('本机上报配置缺少真实法国地址');
    value = config.url;
  }
  return policyOrigin(value.replace(/\/+$/, '')).origin;
}
export async function acceptanceGate(
  gh: Gh,
  repoUrl: string,
  issueNumber: number,
  fetchImpl: typeof fetch = fetch,
  origin?: string,
): Promise<string | undefined> {
  const match = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(repoUrl);
  if (!match?.[1]) throw new Error('验收查询的仓身份不合法');
  const r = await gh(['api', `repos/${match[1]}`]);
  if (r.code !== 0) throw new Error(`验收查询没读成GitHub仓身份：${r.stderr}`);
  const repo = policyRepo(JSON.parse(r.stdout));
  if (repo.repo.toLowerCase() !== match[1].toLowerCase()) throw new Error('验收查询仓身份不匹配');
  const res = await fetchImpl(
    `${origin ?? acceptanceOrigin()}/api/public/acceptance/v1/repos/${repo.githubId}/issues/${issueNumber}`,
    {
      redirect: 'error',
      credentials: 'omit',

      signal: AbortSignal.timeout(20000),
      headers: { accept: 'application/json', 'cache-control': 'no-cache, no-store' },
    },
  );
  if (
    res.status !== 200 ||
    res.redirected ||
    !/^application\/json(?:;|$)/i.test(res.headers.get('content-type') ?? '') ||
    !(res.headers.get('cache-control') ?? '').split(',').some((x) => x.trim() === 'no-store')
  )
    throw new Error(`真实验收责任账未查成（HTTP ${res.status}或缓存/格式不合约）`);
  if (!res.body) throw new Error('验收账没有响应体');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('验收账响应过大，无法完整核实');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(text);
  if (
    !policyRecord(raw) ||
    raw.version !== 1 ||
    raw.githubId !== repo.githubId ||
    raw.repo !== repo.repo ||
    raw.issueNumber !== issueNumber ||
    !Array.isArray(raw.duties)
  )
    throw new Error('验收责任响应身份或协议不匹配');
  const ids = new Set<number>();
  let open = false;
  const finals = new Map<number, { generation: number; prNumber: number; head: string }>();
  const superseded: {
    id: number;
    prNumber: number;
    head: string;
    successorId: number;
    successorGeneration: number;
  }[] = [];
  for (const duty of raw.duties) {
    if (
      !policyRecord(duty) ||
      !Number.isSafeInteger(duty.id) ||
      Number(duty.id) <= 0 ||
      ids.has(Number(duty.id)) ||
      !Number.isSafeInteger(duty.generation) ||
      Number(duty.generation) <= 0 ||
      duty.repo !== repo.repo ||
      duty.issueNumber !== issueNumber ||
      !Number.isSafeInteger(duty.prNumber) ||
      Number(duty.prNumber) < 0 ||
      typeof duty.head !== 'string' ||
      (duty.prNumber === 0 ? duty.head !== '' : !/^([a-f0-9]{40})$/.test(duty.head))
    )
      throw new Error('验收责任精确身份或代次认不出');
    ids.add(Number(duty.id));
    // 有效终态只认读口照 shared 算出来的 state（#3114），不再自己按 settledAt 判；缺了或不认识就是没读成
    if (duty.state !== 'open' && duty.state !== 'settled' && duty.state !== 'superseded')
      throw new Error('验收责任缺有效终态，无法判定能否关单');
    if (duty.state === 'open') {
      if (duty.settledAt !== null) throw new Error('验收责任终态与最终验收回执矛盾');
      open = true;
      continue;
    }
    if (duty.state === 'superseded') {
      if (
        duty.settledAt !== null ||
        // 旧行可能保留历史合并字段；替代成立只认有效 state 与目标最终回执，不把旧字段当旧头已合证明。
        (duty.mergeCommit !== null &&
          (typeof duty.mergeCommit !== 'string' || !/^[a-f0-9]{40}$/.test(duty.mergeCommit))) ||
        typeof duty.supersededAt !== 'string' ||
        !Number.isFinite(Date.parse(duty.supersededAt)) ||
        typeof duty.supersededBy !== 'string' ||
        !duty.supersededBy.trim() ||
        typeof duty.supersedeEvidence !== 'string' ||
        !duty.supersedeEvidence.trim() ||
        !Number.isSafeInteger(duty.successorId) ||
        !Number.isSafeInteger(duty.successorGeneration)
      )
        throw new Error('被替代的验收责任缺可信替代证据');
      superseded.push({
        id: Number(duty.id),
        prNumber: Number(duty.prNumber),
        head: duty.head,
        successorId: Number(duty.successorId),
        successorGeneration: Number(duty.successorGeneration),
      });
      continue;
    }
    finals.set(Number(duty.id), {
      generation: Number(duty.generation),
      prNumber: Number(duty.prNumber),
      head: duty.head,
    });
    if (
      typeof duty.settledAt !== 'string' ||
      !Number.isFinite(Date.parse(duty.settledAt)) ||
      typeof duty.settledBy !== 'string' ||
      !duty.settledBy.trim() ||
      typeof duty.settleEvidence !== 'string' ||
      !duty.settleEvidence.trim() ||
      (duty.prNumber !== 0 &&
        (typeof duty.mergeCommit !== 'string' || !/^[a-f0-9]{40}$/.test(duty.mergeCommit)))
    )
      throw new Error('最终验收缺少可信落账证据');
  }
  // 被替代的必须指向本单里同 PR 另一头、已最终验收且代次吻合的责任；指不到就是账不自洽，不放行
  for (const s of superseded) {
    const target = finals.get(s.successorId);
    if (
      !target ||
      target.generation !== s.successorGeneration ||
      target.prNumber !== s.prNumber ||
      target.head === s.head
    )
      throw new Error('被替代的验收责任指向的最终责任对不上');
  }
  return open ? '数据库里还有未结清的现场验收责任，代码可以合，原单保留' : undefined;
}

/** 来源只认标准 engine App 的精确PR/head status；任意评论和其它Bot不提供读口。 */
export async function acceptanceOriginForPull(gh: Gh, pr: number): Promise<string> {
  if (process.env.GITHUB_ACTIONS !== 'true') return acceptanceOrigin();
  const get = async (path: string) => {
    const r = await gh(['api', path]);
    if (r.code !== 0) throw new Error(`验收来源没查成：${r.stderr}`);
    return JSON.parse(r.stdout) as unknown;
  };
  const repo = policyRepo(await get('repos/{owner}/{repo}'));
  const head = policyHead(await get(`repos/{owner}/{repo}/pulls/${pr}`), repo);
  const login = trustedEngineLogin();
  const bot = await get(`users/${encodeURIComponent(login)}`);
  if (!policyRecord(bot) || !Number.isSafeInteger(bot.id) || bot.type !== 'Bot' || bot.login !== login)
    throw new Error('可信来源writer没查成');
  const rows = await get(`repos/{owner}/{repo}/commits/${head.head}/statuses?per_page=100`);
  if (!Array.isArray(rows) || rows.length >= 100) throw new Error('验收来源statuses没有读全');
  const source = latestPolicyStatus(rows, repo, head.head, Number(bot.id), policySourceContext(pr));
  if (source?.state !== 'success' || head.fork || !repo.public) throw new Error('当前PR缺可信验收只读来源');
  return new URL(parsePolicyUrl(source.target_url, repo.githubId, head)).origin;
}
