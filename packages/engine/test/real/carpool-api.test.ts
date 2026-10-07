// real/carpool-api.ts（#194）：adapters 的原样读数 → 判法的读数；拼车组织状况从账号清单推；配置读不到明确失败。
import type { QuotaConfig, ReclaudeApiRead, ReclaudeOrgRead } from '@fleet-dao/adapters/quota';
import { describe, expect, it } from 'vitest';
import { carpoolApiReader, carpoolOrgState, toCarpoolApiRead } from '../../src/real/carpool-api.ts';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const org = (kind: ReclaudeOrgRead['kind'], over: Partial<ReclaudeOrgRead> = {}): ReclaudeOrgRead => ({
  id: `${kind}-1`,
  kind,
  hasAssignedAccount: true,
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  ...over,
});

describe('拼车组织状况从账号清单推', () => {
  it('没有拼车组织 = none；有可用的 = ok（几个拼车组织里有一个可用就算）', () => {
    expect(carpoolOrgState([org('solo')], NOW)).toBe('none');
    expect(carpoolOrgState([org('carpool')], NOW)).toBe('ok');
    expect(carpoolOrgState([org('carpool', { hasAssignedAccount: false }), org('carpool')], NOW)).toBe('ok');
  });

  it('【故意造出失败】全不可用：没分到账号 = no-account；到期 = expired；回包没说分没分 = unknown，不当成 ok', () => {
    expect(carpoolOrgState([org('carpool', { hasAssignedAccount: false })], NOW)).toBe('no-account');
    expect(carpoolOrgState([org('carpool', { expiresAt: new Date(NOW.getTime() - 1) })], NOW)).toBe(
      'expired',
    );
    expect(carpoolOrgState([org('carpool', { hasAssignedAccount: null })], NOW)).toBe('unknown');
  });
});

describe('toCarpoolApiRead', () => {
  const quota = { usedUsd: 10, limitUsd: 80, resetsAt: null, status: 'active' };
  it('读成：带回额度、回包头 Date/Age、账号清单、拼车组织状况', () => {
    const raw: ReclaudeApiRead = {
      ok: true,
      requestedAt: NOW,
      serverDate: NOW,
      ageSeconds: 3,
      quota,
      orgs: { ok: true, accounts: [org('carpool'), org('solo')] },
    };
    expect(toCarpoolApiRead(raw, NOW)).toMatchObject({
      ok: true,
      ageSeconds: 3,
      quota,
      org: 'ok',
      accounts: [{ kind: 'carpool' }, { kind: 'solo' }],
    });
  });

  it('【故意造出失败】组织接口没读成：org 记 unknown、不带账号清单（不当成「没有组织」）', () => {
    const raw: ReclaudeApiRead = {
      ok: true,
      requestedAt: NOW,
      serverDate: null,
      ageSeconds: null,
      quota,
      orgs: { ok: false, code: 'http', why: '503' },
    };
    const r = toCarpoolApiRead(raw, NOW);
    expect(r).toMatchObject({ ok: true, org: 'unknown' });
    expect(r.ok && 'accounts' in r).toBe(false);
  });

  it('【故意造出失败】整次没读成：原样带 code 和原因', () => {
    const raw: ReclaudeApiRead = { ok: false, requestedAt: NOW, code: 'auth', why: 'Key 失效' };
    expect(toCarpoolApiRead(raw, NOW)).toEqual({
      ok: false,
      requestedAt: NOW,
      code: 'auth',
      why: 'Key 失效',
    });
  });
});

describe('carpoolApiReader：配置读不到、没有拼车池', () => {
  it('【故意造出失败】额度配置读不到：回 ok:false（auth，找不到 Key），不抛、不当成接口正常', async () => {
    const read = carpoolApiReader({
      now: () => NOW,
      loadConfig: async () => {
        throw new Error('deploy/quota.json 不存在');
      },
    });
    const r = await read();
    expect(r).toMatchObject({ ok: false, code: 'auth' });
    expect(!r.ok && r.why).toContain('deploy/quota.json 不存在');
  });

  it('【故意造出失败】配置里没有 reclaude-carpool 池：回 ok:false，写明找不到 Key 文件', async () => {
    const config: QuotaConfig = {
      pools: [{ poolId: 'x', channelId: 'c', reader: 'mirasim-relay' }],
    } as QuotaConfig;
    const r = await carpoolApiReader({ now: () => NOW, loadConfig: async () => config })();
    expect(r).toMatchObject({ ok: false, code: 'auth' });
    expect(!r.ok && r.why).toContain('没有 reclaude-carpool 池');
  });

  it('读成：用配置里的 Key 文件和网址，经注入的 fetch 读两个接口', async () => {
    const config = {
      pools: [
        {
          poolId: 'claude-carpool',
          channelId: 'c',
          reader: 'reclaude-carpool',
          keyFile: '/k/key',
          baseUrl: 'https://example.test',
        },
      ],
    } as unknown as QuotaConfig;
    const urls: string[] = [];
    const read = carpoolApiReader({
      now: () => NOW,
      loadConfig: async () => config,
      io: {
        readFile: async () => `rck_${'a'.repeat(24)}`,
        fetch: (async (url: string | URL | Request) => {
          urls.push(String(url));
          const body = String(url).endsWith('/orgs')
            ? {
                items: [{ type: 'team', has_assigned_account: true, subscription_expires_at: 1900000000000 }],
              }
            : { enabled: true, quota_usd: '80', used_usd: '1', status: 'active' };
          return new Response(JSON.stringify(body), { status: 200 });
        }) as typeof fetch,
      },
    });
    const r = await read();
    expect(r).toMatchObject({ ok: true, org: 'ok', quota: { usedUsd: 1, limitUsd: 80 } });
    expect(urls.sort()).toEqual([
      'https://example.test/api/v1/carpool/quota',
      'https://example.test/api/v1/orgs',
    ]);
  });
});
