import { isDeepStrictEqual } from 'node:util';
import type { NewAuditEntry, NotificationRecord } from './ports.ts';

/** Guarded resolution retains the original notification and accepts only an identical audit replay. */
export interface NotificationResolutionGuard {
  dedupeKey: string;
  body: string;
  link: string;
}

export function matchesNotification(
  row: Pick<NotificationRecord, 'dedupeKey' | 'body' | 'link'>,
  expected: NotificationResolutionGuard,
): boolean {
  return row.dedupeKey === expected.dedupeKey && row.body === expected.body && row.link === expected.link;
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
