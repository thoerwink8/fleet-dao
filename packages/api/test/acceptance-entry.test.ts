import { describe, expect, it } from 'vitest';
import { acceptancePublicRoutes } from '../src/acceptance-public.ts';
import { main } from '../src/cli.ts';
import type { Deps } from '../src/deps.ts';

describe('验收责任只剩只读（#3630，决定 0113 第二片）', () => {
  it('管理命令 fleet-api acceptance 已删：用法里没有，只剩一次性交回的指引', async () => {
    const out: string[] = [];
    const deps = {
      env: {},
      out: (s: string) => out.push(s),
      err: (s: string) => out.push(s),
      now: () => new Date(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: 只用到 env、out、err、now
    expect(await main(['--help'], deps as any)).toBe(0);
    const help = out.join('\n');
    expect(help).not.toMatch(/fleet-api acceptance (status|settle|supersede|merge)/);
    expect(help).toContain('fleet-api acceptance-handback-once [--apply]');
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    expect(await main(['acceptance-handback-once'], deps as any)).toBe(2);
    expect(out.at(-1)).toContain('packages/engine/src/bin/acceptance-handback-once.ts');
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
