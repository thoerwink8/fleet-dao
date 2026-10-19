import { describe, expect, it } from 'vitest';
import { parseAcceptanceArgs } from '../src/acceptance-cli.ts';
import { acceptancePublicRoutes } from '../src/acceptance-public.ts';
import type { Deps } from '../src/deps.ts';

describe('最终验收标准入口', () => {
  it('status只读，settle必须精确身份与代次证据', () => {
    expect(parseAcceptanceArgs(['status', 'o/r', '7'])).toEqual({
      action: 'status',
      repo: 'o/r',
      issueNumber: 7,
    });
    expect(() => parseAcceptanceArgs(['settle', 'o/r', '7', '--evidence', 'done'])).toThrow();
    expect(
      parseAcceptanceArgs([
        'settle',
        'o/r',
        '7',
        '--id',
        '2',
        '--generation',
        '3',
        '--pr',
        '9',
        '--head',
        'a'.repeat(40),
        '--evidence',
        '真实现场记录',
      ]),
    ).toMatchObject({ id: 2, generation: 3, prNumber: 9, head: 'a'.repeat(40) });
    expect(
      parseAcceptanceArgs([
        'settle',
        'o/r',
        '7',
        '--id',
        '2',
        '--generation',
        '3',
        '--pr',
        '0',
        '--head',
        '-',
        '--evidence',
        '协调事项已验',
      ]),
    ).toMatchObject({ prNumber: 0, head: '' });
  });
  it('supersede 源和目标都要精确 id、代次、PR、头和证据，仓单取同一张', () => {
    const args = [
      'supersede',
      'o/r',
      '7',
      '--id',
      '11',
      '--generation',
      '1',
      '--pr',
      '9',
      '--head',
      'a'.repeat(40),
      '--target-id',
      '16',
      '--target-generation',
      '2',
      '--target-pr',
      '9',
      '--target-head',
      'b'.repeat(40),
      '--evidence',
      '最终头已合已验',
    ];
    expect(parseAcceptanceArgs(args)).toEqual({
      action: 'supersede',
      repo: 'o/r',
      issueNumber: 7,
      source: { id: 11, generation: 1, repo: 'o/r', issueNumber: 7, prNumber: 9, head: 'a'.repeat(40) },
      target: { id: 16, generation: 2, repo: 'o/r', issueNumber: 7, prNumber: 9, head: 'b'.repeat(40) },
      evidence: '最终头已合已验',
      coverage: [],
    });
    const without = (flag: string) => {
      const i = args.indexOf(flag);
      return [...args.slice(0, i), ...args.slice(i + 2)];
    };
    for (const flag of [
      '--id',
      '--generation',
      '--pr',
      '--head',
      '--target-id',
      '--target-generation',
      '--target-pr',
      '--target-head',
      '--evidence',
    ])
      expect(() => parseAcceptanceArgs(without(flag))).toThrow(/用法/);
    const bad = [...args];
    bad[bad.indexOf('--target-head') + 1] = '-';
    expect(() => parseAcceptanceArgs(bad)).toThrow(/用法/);
    bad[bad.indexOf('--target-head') + 1] = 'b'.repeat(40);
    bad[bad.indexOf('--target-pr') + 1] = '0';
    expect(() => parseAcceptanceArgs(bad)).toThrow(/用法/);
    expect(() => parseAcceptanceArgs(['settle', ...args.slice(1)])).toThrow(/用法/);
    // 措辞不同的历史项：--coverage 逐条声明，格式不对一律按用法报错
    const entry = { source: '旧写法', target: '新写法', basis: '同一条 CI 全绿 + squash' };
    expect(parseAcceptanceArgs([...args, '--coverage', JSON.stringify([entry])])).toMatchObject({
      coverage: [entry],
    });
    for (const badCoverage of [
      '[]',
      'not json',
      '{}',
      JSON.stringify([{ ...entry, basis: ' ' }]),
      JSON.stringify([{ ...entry, extra: 1 }]),
      JSON.stringify([{ source: 'x', target: 'y' }]),
    ])
      expect(() => parseAcceptanceArgs([...args, '--coverage', badCoverage])).toThrow(/用法/);
    const dup = ['--coverage', JSON.stringify([entry])];
    expect(() => parseAcceptanceArgs([...args, ...dup, ...dup])).toThrow(/用法/);
  });
  it('公开口先复核public仓身份，只返DB责任状态，无公开写口', async () => {
    const calls: string[] = [];
    const app = acceptancePublicRoutes({
      ciPolicyBridge: {
        read: async (id: number) => {
          calls.push(`public:${id}`);
          return { repo: 'o/r' };
        },
      },
      acceptanceDuties: async (x: { repo: string; issueNumber: number }) => {
        calls.push(`${x.repo}#${x.issueNumber}`);
        return [
          {
            id: 2,
            generation: 3,
            repo: 'o/r',
            issueNumber: 7,
            prNumber: 9,
            head: 'a'.repeat(40),
            mergeCommit: null,
            settledAt: null,
            settledBy: null,
            settleEvidence: null,
            items: ['private context'],
          },
        ];
      },
    } as unknown as Deps);
    const res = await app.request('/api/public/acceptance/v1/repos/1/issues/7');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(calls).toEqual(['public:1', 'o/r#7']);
    const body = (await res.json()) as { duties: unknown[] };
    expect(body.duties[0]).toMatchObject({ state: 'open', supersededAt: null, successorId: null });
    expect(JSON.stringify(body)).not.toContain('private context');
    expect((await app.request('/api/public/acceptance/v1/repos/1/issues/7', { method: 'POST' })).status).toBe(
      404,
    );
  });
});
