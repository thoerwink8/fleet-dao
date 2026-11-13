// ADE 的当前状态（#3914）：工作区、单、会话。发生了什么写在事件流里，不在这三张表。
import type { ContextReading } from '@fleet-dao/harness-contract/context-usage';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { adeSessions, adeTasks, adeWorkspaces } from './schema.ts';
import type { Db } from './store.ts';

export interface AdeQueueItem {
  text: string;
  from: { kind: 'user' | 'session'; id: string | null };
  expectReply: boolean;
  hops: number;
  kind: 'chat' | 'report';
}

export type AdeWorkspaceRow = typeof adeWorkspaces.$inferSelect;
export type AdeTaskRow = typeof adeTasks.$inferSelect;
export type AdeSessionRow = typeof adeSessions.$inferSelect;

export function adeQueue(raw: unknown): AdeQueueItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is AdeQueueItem => !!x && typeof x === 'object' && typeof x.text === 'string');
}

export async function listAdeWorkspaces(db: Db): Promise<AdeWorkspaceRow[]> {
  return db.select().from(adeWorkspaces).orderBy(asc(adeWorkspaces.createdAt), asc(adeWorkspaces.id));
}

export async function getAdeWorkspace(db: Db, id: string): Promise<AdeWorkspaceRow | null> {
  const [row] = await db.select().from(adeWorkspaces).where(eq(adeWorkspaces.id, id));
  return row ?? null;
}

export async function insertAdeWorkspace(
  db: Db,
  row: { id: string; name: string; path: string; isGit: boolean; forge: string; remote: string | null },
): Promise<void> {
  await db.insert(adeWorkspaces).values(row);
}

export async function deleteAdeWorkspace(db: Db, id: string): Promise<void> {
  await db.delete(adeWorkspaces).where(eq(adeWorkspaces.id, id));
}

export async function listAdeTasks(db: Db): Promise<AdeTaskRow[]> {
  return db.select().from(adeTasks).orderBy(asc(adeTasks.id));
}

export async function getAdeTask(db: Db, id: number): Promise<AdeTaskRow | null> {
  const [row] = await db.select().from(adeTasks).where(eq(adeTasks.id, id));
  return row ?? null;
}

export async function insertAdeTask(
  db: Db,
  row: { workspaceId: string; title: string; body: string; source: Record<string, unknown> },
): Promise<AdeTaskRow> {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [max] = await tx.select({ n: sql<number>`coalesce(max(${adeTasks.id}), 0)::int` }).from(adeTasks);
    const id = (max?.n ?? 0) + 1;
    const [inserted] = await tx
      .insert(adeTasks)
      .values({ id, workspaceId: row.workspaceId, title: row.title, body: row.body, source: row.source })
      .returning();
    if (!inserted) throw new Error('建单没有返回行');
    return inserted;
  });
}

export interface AdeSessionListOpts {
  /** 标题包含这段就留下。空的不筛。大小写不敏感，`%` `_` `\` 当字面量。 */
  q?: string;
  /** true 只看已归档。缺省排除已归档。 */
  archived?: boolean;
}

function titleNeedle(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listAdeSessions(db: Db, opts: AdeSessionListOpts = {}): Promise<AdeSessionRow[]> {
  const conds = [eq(adeSessions.archived, opts.archived === true)];
  const q = opts.q?.trim();
  if (q) conds.push(sql`${adeSessions.title} ilike ${titleNeedle(q)} escape '\\'`);
  return db
    .select()
    .from(adeSessions)
    .where(and(...conds))
    .orderBy(desc(adeSessions.pinned), desc(adeSessions.updatedAt), desc(adeSessions.id));
}

export async function listRunningAdeSessions(db: Db): Promise<AdeSessionRow[]> {
  return db.select().from(adeSessions).where(eq(adeSessions.status, 'running'));
}

/** 这些号里哪些真有会话行，含已归档。只查给来的号，不扫全表。 */
export async function adeSessionIdsAmong(db: Db, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: adeSessions.id })
    .from(adeSessions)
    .where(inArray(adeSessions.id, [...ids]));
  return rows.map((row) => row.id);
}

export async function getAdeSession(db: Db, id: string): Promise<AdeSessionRow | null> {
  const [row] = await db.select().from(adeSessions).where(eq(adeSessions.id, id));
  return row ?? null;
}

export async function insertAdeSession(
  db: Db,
  row: {
    id: string;
    workspaceId: string;
    parentId: string | null;
    taskId: number | null;
    agent: string;
    model: string;
    worktree: boolean;
    cwd: string;
    title: string;
    hostAlias?: string | null;
  },
): Promise<void> {
  await db.insert(adeSessions).values({
    ...row,
    hostAlias: row.hostAlias ?? null,
    status: 'idle',
    hold: false,
    queue: [],
    runId: null,
    agentSessionId: null,
  });
}

export async function updateAdeSession(
  db: Db,
  id: string,
  patch: Partial<{
    status: 'idle' | 'running';
    hold: boolean;
    queue: AdeQueueItem[];
    runId: string | null;
    agentSessionId: string | null;
    title: string;
    pinned: boolean;
    archived: boolean;
    context: ContextReading | null;
  }>,
): Promise<void> {
  await db
    .update(adeSessions)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(adeSessions.id, id));
}

/** 一轮真的开跑了。排队还没开跑的不加。 */
export async function bumpAdeSessionTurns(db: Db, id: string): Promise<void> {
  await db
    .update(adeSessions)
    .set({ turns: sql`${adeSessions.turns} + 1`, updatedAt: sql`now()` })
    .where(eq(adeSessions.id, id));
}
