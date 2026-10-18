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
    expect(JSON.stringify(await res.json())).not.toContain('private context');
    expect((await app.request('/api/public/acceptance/v1/repos/1/issues/7', { method: 'POST' })).status).toBe(
      404,
    );
  });
});
