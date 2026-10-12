// 命令行工具读数：整行覆盖最近一次。不写「落后」。读不到把原因写进 error，不写 0。
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { cliToolReadings } from '../schema/index.ts';

export interface CliToolReadingRow {
  scope: 'user' | 'npm';
  owner: string;
  tool: string;
  installedVersion: string | null;
  installedError: string | null;
  latestVersion: string | null;
  latestError: string | null;
  releaseVersions: string[] | null;
  checkedAt: Date;
}

function asScope(value: string): 'user' | 'npm' {
  return value === 'npm' ? 'npm' : 'user';
}

function asVersions(value: unknown): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return null;
  return value;
}

export async function listCliToolReadings(db: Db): Promise<CliToolReadingRow[]> {
  const rows = await db.select().from(cliToolReadings);
  return rows.map((row) => ({
    scope: asScope(row.scope),
    owner: row.owner,
    tool: row.tool,
    installedVersion: row.installedVersion,
    installedError: row.installedError,
    latestVersion: row.latestVersion,
    latestError: row.latestError,
    releaseVersions: asVersions(row.releaseVersions),
    checkedAt: row.checkedAt,
  }));
}

export async function saveCliToolReading(db: Db, row: CliToolReadingRow): Promise<void> {
  const values = {
    scope: row.scope,
    owner: row.owner,
    tool: row.tool,
    installedVersion: row.installedVersion,
    installedError: row.installedError,
    latestVersion: row.latestVersion,
    latestError: row.latestError,
    releaseVersions: row.releaseVersions,
    checkedAt: row.checkedAt,
  };
  await db
    .insert(cliToolReadings)
    .values(values)
    .onConflictDoUpdate({
      target: [cliToolReadings.scope, cliToolReadings.owner, cliToolReadings.tool],
      set: {
        installedVersion: values.installedVersion,
        installedError: values.installedError,
        latestVersion: values.latestVersion,
        latestError: values.latestError,
        releaseVersions: values.releaseVersions,
        checkedAt: values.checkedAt,
      },
    });
}

/** 测试用：确认写入按主键盖住旧行。 */
export async function cliToolReadingByKey(
  db: Db,
  key: { scope: string; owner: string; tool: string },
): Promise<CliToolReadingRow | null> {
  const rows = await db.select().from(cliToolReadings).where(eq(cliToolReadings.tool, key.tool));
  const row = rows.find((r) => r.scope === key.scope && r.owner === key.owner);
  if (!row) return null;
  return {
    scope: asScope(row.scope),
    owner: row.owner,
    tool: row.tool,
    installedVersion: row.installedVersion,
    installedError: row.installedError,
    latestVersion: row.latestVersion,
    latestError: row.latestError,
    releaseVersions: asVersions(row.releaseVersions),
    checkedAt: row.checkedAt,
  };
}
