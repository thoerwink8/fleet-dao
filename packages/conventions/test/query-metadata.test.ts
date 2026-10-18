import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type IssueInfo, liveGitHub } from '../src/github-api.ts';
import {
  declaredQueryAxes,
  extractQueryAxes,
  queryAxisProblems,
  resolveQueryAxes,
} from '../src/query-axis.ts';
import { type QueryMetadataPort, reconcileQueryMetadata } from '../src/query-metadata.ts';

const AXES = ['域:engine', '性质:bug'];
const issue = (extra: Partial<IssueInfo> = {}): IssueInfo => ({
  number: 1,
  title: '故障',
  state: 'open',
  isPr: false,
  createdAt: '2026-10-18T00:00:00Z',
  labels: ['缺陷'],
  body: '域: engine\n性质: bug',
  milestone: null,
  ...extra,
});
function fake(extra: Partial<IssueInfo> = {}, source = issue({ number: 12, labels: AXES })) {
  const current = issue(extra);
  const writes: unknown[] = [];
  const gh: QueryMetadataPort = {
    issue: async (n) => structuredClone(n === 1 ? current : source),
    pull: async () => ({ headRef: 'local/12-fix', body: '**需求**：\nCloses #12\n' }),
    addLabels: async (_n, labels) => {
      writes.push(labels);
      current.labels.push(...labels);
    },
  };
  return { current, writes, gh };
}

describe('两轴的明确来源', () => {
  it('只认已知且唯一的值；未知、重复、冲突、缺失都报', () => {
    expect(queryAxisProblems(AXES)).toEqual([]);
    for (const labels of [
      [],
      ['域:other', '性质:bug'],
      ['域:engine', '域:api', '性质:bug'],
      [...AXES, '性质:bug'],
    ])
      expect(queryAxisProblems(labels).length).toBeGreaterThan(0);
  });
  it('独立声明和表单可读；引用、围栏、注释、行内提及不算选择', () => {
    const original =
      '`packages/api/src/request-issue.ts`\n> 域: mirasim\n```\n性质: bug\n```\n<!--\n域: engine\n-->\n域: api\n性质: process';
    const extracted = extractQueryAxes(original);
    expect(extracted.labels).toEqual(['域:api', '性质:process']);
    expect(extracted.withoutDeclarations).toBe(original.replace('域: api', '').replace('性质: process', ''));
    expect(declaredQueryAxes('### 域\n\napi\n\n### 性质\n\nperf')).toEqual(['域:api', '性质:perf']);
    expect(
      declaredQueryAxes(
        '> 域: api\n```\n性质: bug\n```\n<!--\n域: mirasim\n-->\n示例 域:engine\n域: engine\n性质: process',
      ),
    ).toEqual(['域:engine', '性质:process']);
    expect(resolveQueryAxes(['域:api'], '性质: perf', AXES)).toEqual({
      labels: ['域:api', '性质:perf'],
      problems: [],
    });
  });
});

describe('元数据事件读现状、补缺失、再回读', () => {
  it('只补两轴不丢类别/其它标签，重复执行不写；明确未排期保留', async () => {
    const f = fake({ labels: ['缺陷', '冻结'], body: '域: engine\n性质: bug\n排期: 未排期' });
    expect(await reconcileQueryMetadata(f.gh, 1)).toEqual({ changed: true, problems: [] });
    expect(f.current.labels).toEqual(['缺陷', '冻结', ...AXES]);
    expect(f.current.milestone).toBeNull();
    expect(await reconcileQueryMetadata(f.gh, 1)).toEqual({ changed: false, problems: [] });
    expect(f.writes).toHaveLength(1);
  });
  it('PR 来源从当前接口读取，旧事件正文不参与；PR 不挂里程碑', async () => {
    const f = fake({ isPr: true, body: '排期: 当前\nCloses #999' });
    await reconcileQueryMetadata(f.gh, 1);
    expect(f.current.labels).toEqual(['缺陷', ...AXES]);
    expect(f.current.milestone).toBeNull();
    f.current.labels = [];
    f.gh.pull = async () => ({ headRef: 'local/12-fix', body: '**需求**：\nCloses #13\n' });
    await expect(reconcileQueryMetadata(f.gh, 1)).rejects.toThrow('不唯一');
  });
  it('已有齐全分类允许多需求 PR；已有冲突不覆盖', async () => {
    const f = fake({ isPr: true, labels: AXES });
    f.gh.pull = async () => ({ headRef: 'local/12-fix', body: '**需求**：\nCloses #13\n' });
    await reconcileQueryMetadata(f.gh, 1);
    expect(f.writes).toEqual([]);
    const conflict = fake({ labels: [...AXES, '域:api'] });
    expect((await reconcileQueryMetadata(conflict.gh, 1)).problems).toHaveLength(1);
    expect(conflict.writes).toEqual([]);
  });
  it('分类不明不猜，也不调整排期', async () => {
    const unknown = fake({ body: '类别是缺陷，可能是 engine 的 bug' });
    expect((await reconcileQueryMetadata(unknown.gh, 1)).problems).toHaveLength(2);
    expect(unknown.writes).toEqual([]);
  });
  it('对象、来源、写后回读和写失败都不能冒充齐全', async () => {
    const missing = fake();
    missing.gh.issue = async () => undefined;
    await expect(reconcileQueryMetadata(missing.gh, 1)).rejects.toThrow('读不到');
    const from = fake({ isPr: true });
    from.gh.issue = async (n) => (n === 1 ? from.current : undefined);
    await expect(reconcileQueryMetadata(from.gh, 1)).rejects.toThrow('来源单');
    const stale = fake();
    stale.gh.addLabels = async () => {};
    await expect(reconcileQueryMetadata(stale.gh, 1)).rejects.toThrow('回读不一致');
    const failed = fake();
    failed.gh.addLabels = async () => {
      throw new Error('403');
    };
    await expect(reconcileQueryMetadata(failed.gh, 1)).rejects.toThrow('403');
  });
  it('真实 GitHub 端口装配：按现读 PR 来源 POST labels，再 GET 回读', async () => {
    const calls: string[] = [];
    let labels: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/issues/1/labels')) {
        labels = (JSON.parse(String(init?.body)) as { labels: string[] }).labels;
        return Response.json(labels.map((name) => ({ name })));
      }
      if (url.endsWith('/pulls/1'))
        return Response.json({ head: { ref: 'local/12-current' }, body: '**需求**：\nCloses #12\n' });
      const source = url.endsWith('/issues/12');
      return Response.json({
        number: source ? 12 : 1,
        title: '故障',
        state: 'open',
        created_at: '2026-10-18T00:00:00Z',
        labels: (source ? AXES : labels).map((name) => ({ name })),
        body: '',
        milestone: null,
        ...(source ? {} : { pull_request: {} }),
      });
    }) as typeof fetch;
    await reconcileQueryMetadata(liveGitHub('o/r', { GH_TOKEN: 'fake-token' }, { fetchImpl }), 1);
    expect(labels).toEqual(AXES);
    expect(calls.filter((call) => call.endsWith('/issues/1'))).toHaveLength(2);
    expect(calls.some((call) => call === 'POST https://api.github.com/repos/o/r/issues/1/labels')).toBe(true);
  });
});

it('写权限事件只运行可信默认分支；无外部 PR 代码、正文 shell 插值或标签递归', () => {
  const workflow = parse(
    readFileSync(new URL('../../../.github/workflows/query-metadata.yml', import.meta.url), 'utf8'),
  );
  expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'write' });
  expect(workflow.on.issues.types).toEqual(['opened', 'edited', 'reopened']);
  expect(workflow.on.pull_request_target.types).toEqual(['opened', 'edited', 'reopened', 'synchronize']);
  const steps = workflow.jobs.reconcile.steps;
  expect(steps[0].with).toEqual({
    ref: `\${{ github.event.repository.default_branch }}`,
    'persist-credentials': false,
  });
  expect(steps.filter((step: { run?: string }) => step.run).map((step: { run: string }) => step.run)).toEqual(
    ['node packages/conventions/src/bin/query-metadata.ts'],
  );
});
