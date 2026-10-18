import { describe, expect, it } from 'vitest';
import type { GhRequest } from '../src/client.ts';
import { memoryLedger } from '../src/ledger.ts';
import { auditMergedPrs } from '../src/reconcile.ts';
import { REPO_ID, setup, sha } from './helpers.ts';

const SELF = 'thoerwink8/fleet-dao';
async function run(
  o: {
    slug?: string;
    author?: 'engine' | 'agent';
    humanMerge?: boolean;
    branch?: string;
    extraFile?: boolean;
    filesFail?: boolean;
    fork?: boolean;
  } = {},
) {
  const { fake } = setup();
  const slug = o.slug ?? SELF;
  const [owner = '', name = ''] = slug.split('/');
  const ledger = memoryLedger({ repos: [{ id: REPO_ID, owner, name }] });
  const p = fake.addPull({
    user: fake.bots[o.author ?? 'engine'],
    head: { ref: o.branch ?? 'changelog/v4', sha: sha('a') },
    state: 'closed',
    merged: true,
    merged_at: '2026-09-25T11:00:00Z',
    merge_commit_sha: sha('b'),
    merged_by: o.humanMerge ? fake.human : fake.bots.engine,
  });
  const pr = {
    ...p,
    head: { ...p.head, repo: { full_name: o.fork ? 'elsewhere/fork' : slug } },
    base: { ...p.base, sha: sha('c'), repo: { full_name: slug } },
    node_id: `PR_${p.number}`,
    html_url: `https://github.com/${slug}/pull/${p.number}`,
  };
  const calls: string[] = [];
  const report = await auditMergedPrs(
    {
      ledger,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      bots: {
        is: (role: 'engine' | 'agent', user: { id: number } | null) => user?.id === fake.bots[role].id,
      },
      client: {
        pages: async function* () {
          yield { data: [pr] };
        },
        request: async (req: GhRequest) => {
          calls.push(req.path);
          return { status: 200, data: pr };
        },
        all: async (req: GhRequest) => {
          calls.push(req.path);
          if (o.filesFail) throw new Error('files分页失败');
          return [
            { filename: 'CHANGELOG.md', status: 'modified' },
            ...(o.extraFile ? [{ filename: 'packages/engine/src/main.ts', status: 'modified' }] : []),
          ];
        },
      },
    } as never,
    slug,
    new Date(0),
  );
  return { report, calls, number: pr.number };
}

describe('更新日志自动PR的合并对账', () => {
  it('仅本仓、引擎开合、规范版本分支、唯一CHANGELOG修改免任务队列；仍按真实回执补账', async () => {
    const { report, number, calls } = await run();
    expect(report.outcome).toBe('ok');
    expect(report.engineChangelogPrs).toEqual([number]);
    expect(report.findings.map((f) => f.kind)).toContain('backfill_merge_record');
    expect(report.findings.map((f) => f.kind)).not.toContain('no_merge_record');
    expect(calls.filter((s) => s.endsWith('/files'))).toHaveLength(1);
  });
  it.each([
    { slug: 'acme/widgets' },
    { author: 'agent' as const },
    { humanMerge: true },
    { branch: 'changelog/pretend' },
    { branch: 'changelog/v3' },
    { extraFile: true },
    { fork: true },
  ])('【故意反例】不满足精确限定仍报绕队列：%j', async (o) => {
    const { report } = await run(o);
    expect(report.engineChangelogPrs).toEqual([]);
    expect(report.findings.map((f) => f.kind)).toContain('no_merge_record');
  });
  it('文件读不到明确partial，不凭分支猜豁免', async () => {
    const { report } = await run({ filesFail: true });
    expect(report.outcome).toBe('partial');
    expect(report.engineChangelogPrs).toEqual([]);
    expect(report.findings.map((f) => f.kind)).toContain('unchecked');
  });
});
