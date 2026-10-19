import { isDeepStrictEqual } from 'node:util';
import type { NewAuditEntry } from './ports.ts';

export const HISTORICAL_CHECKOUT_ACTION = 'notification.checkout_history_archive';
export const HISTORICAL_CHECKOUT_ACTOR = { kind: 'ops', id: 'ops:checkout-history' } as const;

/** Guarded resolution retains the original notification and accepts only an identical audit replay. */
export interface NotificationResolutionGuard {
  dedupeKey: string;
  body: string;
  link?: string | null;
  /** 同一 dedupe key 重开时的事故代次；老调用不带它，历史 checkout 必须带。 */
  raisedAt?: string;
}

export function matchesNotification(
  row: {
    dedupeKey?: string | undefined;
    body?: string | undefined;
    link?: string | null | undefined;
    raisedAt?: string | Date | null | undefined;
  },
  expected: NotificationResolutionGuard,
): boolean {
  const rawRaisedAt = row.raisedAt;
  const raisedAt = rawRaisedAt instanceof Date ? rawRaisedAt.toISOString() : rawRaisedAt;
  return (
    row.dedupeKey === expected.dedupeKey &&
    row.body === expected.body &&
    (expected.link === undefined ? true : (row.link ?? null) === expected.link) &&
    (expected.raisedAt === undefined || raisedAt === expected.raisedAt)
  );
}

export function sameResolutionAudit(a: NewAuditEntry, b: NewAuditEntry): boolean {
  return (
    a.action === b.action &&
    a.target === b.target &&
    a.via === b.via &&
    a.ok === b.ok &&
    isDeepStrictEqual(a.actor, b.actor) &&
    isDeepStrictEqual(a.after, b.after) &&
    a.reason === b.reason
  );
}
