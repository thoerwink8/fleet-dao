// 读一次 reclaude 开放接口给切号判法用（#194，方案 v2 4.1）：配置（Key 文件路径、网址）取额度配置里那个 reclaude-carpool 池，
// 读法在 adapters 的 readReclaudeApi（带回包头 Date、Age、每个组织一个账号），这里把它转成判法认的 CarpoolApiRead。
//
// 改这里之前必须知道：
// - 配置读不到、没有 reclaude-carpool 池：回 ok:false（code auth，Key 没处找），不抛、不当成「接口正常」。
// - 拼车组织状况（org）从账号清单里推：没有拼车组织 = none；有可用的（分到账号、没到期）= ok；全不可用按「没分到账号」「到期」
//   的顺序报最先的那种；组织接口没读成、回包没说分没分到 = unknown（判法不当成能用）。

import {
  loadQuotaConfig,
  productionQuotaIo,
  type QuotaConfig,
  type ReclaudeApiIo,
  type ReclaudeApiRead,
  type ReclaudeOrgRead,
  readReclaudeApi,
} from '@fleet-dao/adapters/quota';
import { errMessage } from '@fleet-dao/shared/util';
import type { CarpoolApiRead, CarpoolOrgState } from '../jobs/carpool-outage.ts';

export function carpoolOrgState(accounts: readonly ReclaudeOrgRead[], now: Date): CarpoolOrgState {
  const teams = accounts.filter((a) => a.kind === 'carpool');
  if (teams.length === 0) return 'none';
  const usable = (a: ReclaudeOrgRead) =>
    a.hasAssignedAccount === true && !(a.expiresAt && a.expiresAt.getTime() <= now.getTime());
  if (teams.some(usable)) return 'ok';
  if (teams.some((a) => a.hasAssignedAccount === false)) return 'no-account';
  if (teams.some((a) => a.expiresAt && a.expiresAt.getTime() <= now.getTime())) return 'expired';
  return 'unknown';
}

/** adapters 的原样读数 → 判法的读数。 */
export function toCarpoolApiRead(r: ReclaudeApiRead, now: Date): CarpoolApiRead {
  if (!r.ok) return { ok: false, requestedAt: r.requestedAt, code: r.code, why: r.why };
  return {
    ok: true,
    requestedAt: r.requestedAt,
    serverDate: r.serverDate,
    ageSeconds: r.ageSeconds,
    quota: r.quota,
    org: r.orgs.ok ? carpoolOrgState(r.orgs.accounts, now) : 'unknown',
    ...(r.orgs.ok ? { accounts: r.orgs.accounts } : {}),
  };
}

export interface CarpoolApiWiring {
  io?: Partial<ReclaudeApiIo>;
  now?: () => Date;
  loadConfig?: () => Promise<QuotaConfig>;
}

/** 整次最多等多久：两个接口并发，正常几百毫秒。 */
export const CARPOOL_API_TIMEOUT_MS = 20_000;

export function carpoolApiReader(w: CarpoolApiWiring = {}): () => Promise<CarpoolApiRead> {
  const now = w.now ?? (() => new Date());
  return async () => {
    const at = now();
    let config: QuotaConfig;
    try {
      config = await (w.loadConfig ?? (() => loadQuotaConfig()))();
    } catch (err) {
      return {
        ok: false,
        requestedAt: at,
        code: 'auth',
        why: `额度配置读不到，找不到 reclaude Key：${errMessage(err)}`,
      };
    }
    const pool = config.pools.find((p) => p.reader === 'reclaude-carpool');
    if (!pool || pool.reader !== 'reclaude-carpool') {
      return {
        ok: false,
        requestedAt: at,
        code: 'auth',
        why: '额度配置里没有 reclaude-carpool 池，找不到 Key 文件',
      };
    }
    const prod = productionQuotaIo();
    const raw = await readReclaudeApi(
      {
        fetch: prod.fetch,
        readFile: prod.readFile,
        homeDir: prod.homeDir,
        now,
        timeoutMs: CARPOOL_API_TIMEOUT_MS,
        ...(w.io ?? {}),
      },
      { keyFile: pool.keyFile, ...(pool.baseUrl ? { baseUrl: pool.baseUrl } : {}) },
    );
    return toCarpoolApiRead(raw, now());
  };
}
