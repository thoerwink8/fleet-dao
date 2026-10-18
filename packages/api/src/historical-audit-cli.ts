import type { Store } from '@fleet-dao/store';
import { z } from 'zod';

export const HISTORICAL_AUDIT_USAGE =
  'fleet-api historical-audit：从标准输入读 JSON（notificationId、dedupeKey、repo、pr、head、evidenceIssue、conclusion=historical_unproven、evidence、gaps、responsibility）。只处置历史通知，不证明经过队列、不修改合并账。';
const Text = z.string().trim().min(1).max(8000);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Input = z
  .object({
    notificationId: z.string().uuid(),
    dedupeKey: Text,
    repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    pr: z.number().int().positive(),
    head: Sha,
    evidenceIssue: z.string().url(),
    conclusion: z.literal('historical_unproven'),
    evidence: Text,
    gaps: Text,
    responsibility: Text,
  })
  .strict();
const Pull = z.object({
  number: z.number().int(),
  state: z.literal('closed'),
  merged: z.literal(true),
  html_url: z.string().url(),
  head: z.object({ sha: Sha }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
  merge_commit_sha: Sha,
  merged_at: z.string().datetime(),
  merged_by: z.object({ id: z.number().int().positive(), login: Text }),
});
const Issue = z.object({
  number: z.number().int(),
  html_url: z.string().url(),
  body: Text,
  pull_request: z.unknown().optional(),
});

export interface HistoricalAuditSource {
  read(repo: string, path: string): Promise<unknown>;
}

/** Existing engine installation credentials, GET only; no network-facing write endpoint or new identity. */
export async function openHistoricalAuditSource(
  url: string,
): Promise<{ source: HistoricalAuditSource; close(): Promise<void> }> {
  const { createDb } = await import('@fleet-dao/db');
  const { pgLedger, pgLocker, withStatementTimeout } = await import('@fleet-dao/store');
  const { createGitHub } = await import('@fleet-dao/github');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  try {
    return {
      source: historicalAuditSource(createGitHub({ ledger: pgLedger(db), locker: pgLocker(db) }).client),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function historicalAuditSource(
  client: Pick<import('@fleet-dao/github').GitHub['client'], 'request'>,
): HistoricalAuditSource {
  return {
    async read(repo, path) {
      const [owner = '', name = ''] = repo.split('/');
      const response = await client.request({
        method: 'GET',
        path: `/repos/${repo}/${path}`,
        auth: { as: 'engine', repo: { owner, name } },
      });
      return response.data;
    },
  };
}

export function parseHistoricalAudit(text: string) {
  const input = Input.parse(JSON.parse(text));
  if (input.dedupeKey !== `reconcile:pr:${input.repo}#${input.pr}`) throw new Error('通知键与仓/PR不一致');
  if (
    !new RegExp(`^https://github\\.com/${input.repo.replaceAll('.', '\\.')}/issues/[1-9][0-9]*$`).test(
      input.evidenceIssue,
    )
  )
    throw new Error('证据必须是同仓 GitHub issue URL');
  return input;
}

export async function resolveHistoricalAudit(
  input: z.infer<typeof Input>,
  deps: {
    store: Pick<Store, 'findRepoByName' | 'listNotifications' | 'resolveNotification'>;
    source: HistoricalAuditSource;
    operator: string;
  },
) {
  // Runtime validation also covers callers other than the CLI parser.
  input = parseHistoricalAudit(JSON.stringify(input));
  if (!deps.operator.trim()) throw new Error('缺少实际 ops 操作者');
  const [owner = '', name = ''] = input.repo.split('/');
  if (!(await deps.store.findRepoByName(owner, name))) throw new Error('仓未登记，不能处置');
  const prUrl = `https://github.com/${input.repo}/pull/${input.pr}`;
  let notification: Awaited<ReturnType<Store['listNotifications']>>['items'][number] | undefined;
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await deps.store.listNotifications({
      status: 'all',
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    notification = page.items.find((n) => n.id === input.notificationId);
    if (notification) break;
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('通知翻页未前进，未查成');
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (
    !notification ||
    notification.level !== 'alert' ||
    notification.dedupeKey !== input.dedupeKey ||
    notification.link !== prUrl
  )
    throw new Error('原通知身份或 PR 来源不匹配');
  const pull = Pull.parse(await deps.source.read(input.repo, `pulls/${input.pr}`));
  if (
    pull.number !== input.pr ||
    pull.base.repo.full_name !== input.repo ||
    pull.html_url !== prUrl ||
    pull.head.sha !== input.head
  )
    throw new Error('GitHub PR 仓、编号、head 与处置目标不匹配');
  const evidenceNumber = Number(input.evidenceIssue.split('/').at(-1));
  const issue = Issue.parse(await deps.source.read(input.repo, `issues/${evidenceNumber}`));
  if (
    issue.pull_request !== undefined ||
    issue.number !== evidenceNumber ||
    issue.html_url !== input.evidenceIssue
  )
    throw new Error('证据 issue 来源不匹配');
  if (!issue.body.includes(prUrl) && !new RegExp(`#${input.pr}(?![0-9])`).test(issue.body))
    throw new Error('证据 issue 正文未指向被审计 PR');
  const by = { kind: 'ops' as const, id: 'ops:historical-audit' };
  const result = await deps.store.resolveNotification(
    {
      id: notification.id,
      by,
      expected: { dedupeKey: input.dedupeKey, body: notification.body, link: prUrl },
    },
    {
      actor: by,
      action: 'notification.historical_audit',
      target: `notification:${notification.id}`,
      via: 'ops',
      ok: true,
      reason: '历史证据未证明完整队列，按已有通知处理机制记录审计处置，不作为合前授权或正常合并账',
      after: {
        ...input,
        operator: deps.operator,
        originalBody: notification.body,
        evidenceIssueSnapshot: { number: issue.number, body: issue.body },
        github: {
          head: pull.head.sha,
          mergeCommit: pull.merge_commit_sha,
          mergedAt: pull.merged_at,
          mergedBy: pull.merged_by,
        },
      },
    },
  );
  if (result !== 'ok' && result !== 'already_resolved') throw new Error(`历史通知未处置：${result}`);
  return {
    result,
    conclusion: input.conclusion,
    message: '已审计处置；历史合并队列仍未证明，原始事实与合并账保持不变',
  };
}
