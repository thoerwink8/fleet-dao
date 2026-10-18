import { parsePrivateQuotes } from '@fleet-dao/shared';
import { asc, eq, gte } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { privateQuotes } from '../schema/private-quotes.ts';

/** 同 id 同内容才是幂等；冲突整批回滚，不覆盖原话。 */
export async function putPrivateQuotes(db: Db, raw: unknown): Promise<string[]> {
  const quotes = parsePrivateQuotes(raw);
  return db.transaction(async (tx) => {
    for (const q of quotes) {
      const row = { ...q, spokenAt: new Date(q.spokenAt) };
      await tx.insert(privateQuotes).values(row).onConflictDoNothing();
      const [saved] = await tx.select().from(privateQuotes).where(eq(privateQuotes.id, q.id));
      if (
        !saved ||
        Object.entries(row).some(([k, v]) =>
          k === 'spokenAt'
            ? saved.spokenAt.getTime() !== row.spokenAt.getTime()
            : saved[k as keyof typeof saved] !== v,
        )
      )
        throw new Error('私有原话编号冲突，未覆盖。');
    }
    return [...new Set(quotes.map((q) => q.id))];
  });
}
export async function getPrivateQuote(db: Db, id: string) {
  const [row] = await db.select().from(privateQuotes).where(eq(privateQuotes.id, id));
  return row ?? null;
}
export function listPrivateQuotes(db: Db, since: Date) {
  return db
    .select()
    .from(privateQuotes)
    .where(gte(privateQuotes.spokenAt, since))
    .orderBy(asc(privateQuotes.spokenAt), asc(privateQuotes.id));
}
