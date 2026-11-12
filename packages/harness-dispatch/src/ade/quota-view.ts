// 设置页上的额度一行（#3925）。读得成才显示读数；读不成写「读不到」，不补 0。
import { productionQuotaIo, type QuotaReading, readAllQuotas, usageArgs } from '@fleet-dao/adapters/quota';
import { findAgentBin } from './agents.ts';

export const UNREAD = '读不到';

const AGENTS = ['claude', 'grok', 'codex', 'pi'] as const;

export function formatQuota(
  windows: readonly Pick<QuotaReading, 'label' | 'used' | 'limit' | 'unit' | 'utilization'>[],
): string | null {
  const parts: string[] = [];
  for (const w of windows) {
    const name = w.label?.trim() || '额度';
    if (typeof w.used === 'number' && typeof w.limit === 'number') {
      parts.push(w.unit === 'percent' ? `${name} ${w.used}%` : `${name} ${w.used}/${w.limit}`);
    } else if (typeof w.utilization === 'number' && Number.isFinite(w.utilization)) {
      parts.push(`${name} ${Math.round(w.utilization * 1000) / 10}%`);
    }
  }
  return parts.length ? parts.join(' · ') : null;
}

export function unreadQuota(): Record<string, string> {
  return Object.fromEntries(AGENTS.map((id) => [id, UNREAD]));
}

/** 只读本机 CLI 的额度。失败、超时、空窗口都是「读不到」。codex 和 pi 没有读取器。 */
export async function readLocalQuota(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const out = unreadQuota();
  try {
    const bin = await findAgentBin('claude', env);
    const report = await readAllQuotas(
      {
        timeoutMs: 12_000,
        pools: [
          ...(bin
            ? [
                {
                  poolId: 'local-claude',
                  channelId: 'local',
                  reader: 'claude-usage' as const,
                  command: [bin, ...usageArgs()],
                  timeoutMs: 12_000,
                },
              ]
            : []),
          {
            poolId: 'local-grok',
            channelId: 'local',
            reader: 'grok-billing' as const,
            timeoutMs: 12_000,
          },
        ],
      },
      productionQuotaIo(),
    );
    for (const row of report.results) {
      const agent = row.poolId === 'local-claude' ? 'claude' : row.poolId === 'local-grok' ? 'grok' : '';
      if (!agent || !row.ok) continue;
      const line = formatQuota(row.windows);
      if (line) out[agent] = line;
    }
  } catch {
    return out;
  }
  return out;
}
