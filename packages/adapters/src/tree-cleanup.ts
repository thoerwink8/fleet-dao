import { execFile } from 'node:child_process';

export interface TreeIdentity {
  lex: string;
  real: string;
  dev: string;
  ino: string;
  uid: string;
}

export interface TreeHelperOptions {
  helper?: string;
  sudo?: readonly string[];
  signal?: AbortSignal;
}

type Reply = Record<string, unknown>;

/** Only the fixed root helper can attest this private namespace; never inspect it as a session. */
export const CLEANUP_TRANSACTION_DIR = '.cleanup-transactions';

export class TreeHelperError extends Error {
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function call(options: TreeHelperOptions, args: string[]): Promise<Reply> {
  const [bin, ...rest] = [
    ...(options.sudo ?? ['/usr/bin/sudo', '-n']),
    options.helper ?? '/usr/local/sbin/fleet-agent-scope',
    ...args,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      bin as string,
      rest,
      {
        encoding: 'utf8',
        timeout: 115_000,
        maxBuffer: 128 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error)
          return reject(
            new TreeHelperError(
              `受管删树未完成：${stderr.slice(0, 1000)} ${stdout.slice(0, 2000)} ${error.message}`,
              typeof error.code === 'number' ? error.code : null,
            ),
          );
        try {
          const value: unknown = JSON.parse(stdout);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('非对象回执');
          const row = value as Reply;
          if (row.version !== 1 || typeof row.state !== 'string' || row.state === 'unknown')
            throw new Error('删树协议版本/状态不完整');
          resolve(row);
        } catch (error) {
          reject(new Error(`受管删树回执读失败：${String(error)}`));
        }
      },
    );
  });
}

/** No cached capability can authorize a later call against a replaced/old helper. */
export async function invokeTreeHelper(options: TreeHelperOptions, args: string[]): Promise<Reply> {
  const capability = await call(options, ['capabilities']);
  const features = capability.features;
  if (
    capability.state !== 'ok' ||
    !Array.isArray(features) ||
    ![
      'tree-usage',
      'identity-remove',
      'cleanup-status',
      'cleanup-rollback',
      'locked-adopt',
      'temporary-files',
    ].every((name) => features.includes(name))
  )
    throw new Error('受管帮手不支持完整删树协议（含 temporary-files），保留原对象');
  return call(options, args);
}

export function treeIdentity(value: unknown): TreeIdentity {
  if (!value || typeof value !== 'object') throw new Error('缺少工作树身份');
  const row = value as Reply;
  if (
    typeof row.lex !== 'string' ||
    !row.lex.startsWith('/') ||
    row.real !== row.lex ||
    !['dev', 'ino', 'uid'].every(
      (key) => typeof row[key] === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(row[key] as string),
    )
  )
    throw new Error('工作树身份无效');
  return {
    lex: row.lex,
    real: row.lex,
    dev: row.dev as string,
    ino: row.ino as string,
    uid: row.uid as string,
  };
}

function identityArgs(identity: TreeIdentity): string[] {
  const place = treeIdentity(identity);
  return [place.real, '--dev', place.dev, '--ino', place.ino, '--uid', place.uid];
}

function assertIdentity(reply: Reply, expected: TreeIdentity): void {
  const actual = treeIdentity(reply.identity);
  if (
    Object.keys(actual).some(
      (key) => actual[key as keyof TreeIdentity] !== expected[key as keyof TreeIdentity],
    )
  )
    throw new Error('回执不是原授权工作树');
}

export async function readTreePlace(
  dir: string,
  options: TreeHelperOptions = {},
): Promise<TreeIdentity | null> {
  const reply = await invokeTreeHelper(options, ['tree-place', dir]);
  if (reply.state === 'gone') return null;
  const place = treeIdentity(reply.identity);
  if (reply.state !== 'ok' || place.real !== dir) throw new Error('临时工作树身份读回不匹配');
  return place;
}

export async function readTreeUsage(
  identity: TreeIdentity,
  options: TreeHelperOptions = {},
): Promise<'idle' | 'busy' | 'unknown'> {
  try {
    const reply = await invokeTreeHelper(options, ['tree-usage', ...identityArgs(identity)]);
    assertIdentity(reply, identity);
    if (!Number.isSafeInteger(reply.scanned) || (reply.scanned as number) <= 0 || reply.failed !== 0)
      return 'unknown';
    return reply.state === 'idle' || reply.state === 'busy' ? reply.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function removeTreeIdentity(
  identity: TreeIdentity,
  options: TreeHelperOptions = {},
): Promise<void> {
  const reply = await invokeTreeHelper(options, ['remove', ...identityArgs(identity)]);
  assertIdentity(reply, identity);
  if (
    reply.state !== 'removed' ||
    typeof reply.transaction !== 'string' ||
    !/^[a-f0-9]{64}$/.test(reply.transaction)
  )
    throw new Error('未收到原授权对象删除回执');
}

export async function cleanupStatus(options: TreeHelperOptions = {}): Promise<Reply[]> {
  return (await readCleanupPages(options)).rows;
}

/** Bounds of one whole cleanup-status read; past any of them the list stays incomplete. */
export const CLEANUP_PAGE_LIMITS = { pages: 256, rounds: 3, rows: 5000, bytes: 8 * 1024 * 1024, ms: 300_000 };

const HASH = /^[0-9a-f]{64}$/;
const ROUND = /^[0-9a-f]{32}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2048}\.[0-9a-f]{64}$/;

function incomplete(why: string): Error {
  return new Error(`清理事务列表不完整：${why}`);
}

/**
 * Walk every helper page; only a final page with truncated=false proves the list complete. The
 * cursor is opaque and signed by the helper (position, namespace stamp, digests, round bounds);
 * this side checks the chain: one round, consecutive pages, each starting at the bucket the last
 * one stopped at, rows inside that range, no cursor or row twice. state=changed restarts the whole
 * round (bounded), so pages of different rounds are never stitched.
 */
async function readCleanupPages(options: TreeHelperOptions): Promise<{ rows: Reply[]; namespace: unknown }> {
  const deadline = Date.now() + CLEANUP_PAGE_LIMITS.ms;
  for (let round = 0; round < CLEANUP_PAGE_LIMITS.rounds; round++) {
    const done = await readCleanupRound(options, deadline);
    if (done) return done;
  }
  throw incomplete(`命名空间连续 ${CLEANUP_PAGE_LIMITS.rounds} 轮在翻页中换代`);
}

async function readCleanupRound(
  options: TreeHelperOptions,
  deadline: number,
): Promise<{ rows: Reply[]; namespace: unknown } | null> {
  const rows: Reply[] = [];
  const ids = new Set<string>();
  const seen = new Set<string>();
  let bytes = 0;
  let round: { id: string; namespace: TreeIdentity } | null = null;
  let through: string | null = null;
  let cursor: string | null = null;
  for (let page = 1; ; page++) {
    if (page > CLEANUP_PAGE_LIMITS.pages) throw incomplete(`超过 ${CLEANUP_PAGE_LIMITS.pages} 页上限`);
    const left = deadline - Date.now();
    if (left <= 0) throw incomplete('整轮读取超时');
    const signal = AbortSignal.any([AbortSignal.timeout(left), ...(options.signal ? [options.signal] : [])]);
    let reply: Reply;
    try {
      reply = await invokeTreeHelper(
        { ...options, signal },
        cursor ? ['cleanup-status', '--cursor', cursor] : ['cleanup-status'],
      );
    } catch (error) {
      throw incomplete(`第 ${page} 页读失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (reply.state === 'changed') return null;
    bytes += Buffer.byteLength(JSON.stringify(reply));
    if (reply.state !== 'ok' || !Array.isArray(reply.rows) || typeof reply.truncated !== 'boolean')
      throw incomplete(`第 ${page} 页回执不完整`);
    // A helper without pages answers one untruncated page; it is complete only because it says so.
    const legacy = page === 1 && !reply.truncated && reply.round === undefined;
    if (round) {
      if (reply.round !== round.id || reply.page !== page) throw incomplete(`第 ${page} 页不是本轮的下一页`);
      if (JSON.stringify(treeIdentity(reply.namespace)) !== JSON.stringify(round.namespace))
        throw incomplete('翻页中命名空间身份变了');
    } else if (!legacy) {
      if (typeof reply.round !== 'string' || !ROUND.test(reply.round) || reply.page !== 1)
        throw incomplete('帮手不支持分页游标，只读到前缀');
      if (reply.truncated) round = { id: reply.round, namespace: treeIdentity(reply.namespace) };
    }
    const from = reply.from ?? null;
    const end = reply.through ?? null;
    if (!legacy) {
      if (from !== through) throw incomplete(`第 ${page} 页不是从上一页停下的桶接着读`);
      if (end !== null && (typeof end !== 'string' || !HASH.test(end) || (from !== null && end < from)))
        throw incomplete(`第 ${page} 页读到的位置缺失或回退`);
    }
    if (reply.truncated) {
      if (typeof reply.cursor !== 'string' || !CURSOR.test(reply.cursor) || seen.has(reply.cursor))
        throw incomplete(`第 ${page} 页游标缺失或重复`);
      seen.add(reply.cursor);
    }
    for (const row of reply.rows as unknown[]) {
      const r = row as Reply;
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !HASH.test(r.id))
        throw incomplete(`第 ${page} 页有坏记录`);
      const ph = r.pathHash;
      if (
        typeof ph !== 'string' ||
        !HASH.test(ph) ||
        (!legacy && (end === null || ph > end || (from !== null && ph <= from)))
      )
        throw incomplete(`第 ${page} 页记录不在本页读到的桶范围内`);
      if (ids.has(r.id)) throw incomplete(`第 ${page} 页记录重复`);
      ids.add(r.id);
      rows.push(r);
    }
    if (rows.length > CLEANUP_PAGE_LIMITS.rows || bytes > CLEANUP_PAGE_LIMITS.bytes)
      throw incomplete('整轮记录条数或字节超过上限');
    if (!reply.truncated) return { rows, namespace: reply.namespace };
    through = end as string | null;
    cursor = reply.cursor as string;
  }
}

/** A missing/old/failed helper response cannot exempt a root entry from the sweep. */
export async function readCleanupNamespace(root: string, options: TreeHelperOptions = {}): Promise<Reply[]> {
  const { rows, namespace: claimed } = await readCleanupPages(options);
  const namespace = treeIdentity(claimed);
  if (namespace.real !== `${root}/${CLEANUP_TRANSACTION_DIR}` || namespace.uid !== '0')
    throw new Error('清理事务命名空间身份不匹配');
  return rows;
}
