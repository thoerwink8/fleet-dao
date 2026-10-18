import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true, mode: 'date' } as const;
/** 不接公开 API 或实时广播。 */
export const privateQuotes = pgTable(
  'private_quotes',
  {
    id: uuid('id').primaryKey(),
    spokenAt: timestamp('spoken_at', tz).notNull(),
    text: text('text').notNull(),
    machine: text('machine').notNull(),
    lineage: text('lineage').notNull(),
    remote: text('remote'),
    directiveId: text('directive_id'),
    receivedAt: timestamp('received_at', tz).notNull().defaultNow(),
  },
  (t) => [index('private_quotes_spoken_at_idx').on(t.spokenAt, t.id)],
);
