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
  /** 单次帮手调用的期限；默认 115 秒，只给测试缩短。 */
  timeoutMs?: number;
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

/**
 * tree-usage 答不出 idle/busy 时的原因类别。只有固定枚举和安全整数，不带 stderr、命令行、环境或异常原文。
 * call-failed 帮手非零退出或起不来；aborted 调用方取消；timeout 本端期限到了杀掉帮手；protocol 回执或能力不是完整协议；
 * identity 请求或回执不是原授权工作树；incomplete 扫描不完整（scanned/failed）；helper-unknown 帮手自己答 unknown；
 * unknown 缺证，认不出是哪一类。
 */
export type TreeUsageReason =
  | 'call-failed'
  | 'aborted'
  | 'timeout'
  | 'protocol'
  | 'identity'
  | 'incomplete'
  | 'helper-unknown'
  | 'unknown';

export interface TreeUsageReading {
  state: 'idle' | 'busy' | 'unknown';
  reason?: TreeUsageReason;
  exitCode?: number;
  scanned?: number;
  failed?: number;
}

/** 帮手调用失败的类别只记在本模块；错误原文照旧，不随类别外传。 */
const FAULT = new WeakMap<object, { reason: TreeUsageReason; exitCode?: number }>();

/** tree-usage 里版本合法的 unknown 回执原件；call 照旧拒绝它，类别由读取方核完身份再定。 */
const UNKNOWN_REPLY = new WeakMap<object, Reply>();

function fault<E extends object>(error: E, reason: TreeUsageReason, exitCode?: number | null): E {
  FAULT.set(error, {
    reason,
    ...(typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
  });
  return error;
}

async function call(options: TreeHelperOptions, args: string[]): Promise<Reply> {
  if (options.signal?.aborted) {
    const why: unknown = options.signal.reason;
    throw fault(why && typeof why === 'object' ? why : new Error('受管帮手调用已取消'), 'aborted');
  }
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
        timeout: options.timeoutMs ?? 115_000,
        maxBuffer: 128 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : null;
          // 取消先认（取消也会杀帮手）；回执超出缓冲是协议坏；剩下只有本端期限到了才会自己杀帮手。
          const reason: TreeUsageReason =
            options.signal?.aborted || error.name === 'AbortError'
              ? 'aborted'
              : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                ? 'protocol'
                : error.killed && error.signal === 'SIGTERM'
                  ? 'timeout'
                  : 'call-failed';
          return reject(
            fault(
              new TreeHelperError(
                `受管删树未完成：${stderr.slice(0, 1000)} ${stdout.slice(0, 2000)} ${error.message}`,
                exitCode,
              ),
              reason,
              exitCode,
            ),
          );
        }
        let unknownReply: Reply | undefined;
        try {
          const value: unknown = JSON.parse(stdout);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('非对象回执');
          const row = value as Reply;
          // 只有 tree-usage 的 unknown 可能是帮手的明确答复；它是否可信要等身份核过，这里先留着原回执。
          if (row.version === 1 && row.state === 'unknown' && args[0] === 'tree-usage') unknownReply = row;
          if (row.version !== 1 || typeof row.state !== 'string' || row.state === 'unknown')
            throw new Error('删树协议版本/状态不完整');
          resolve(row);
        } catch (error) {
          const failure = fault(new Error(`受管删树回执读失败：${String(error)}`), 'protocol');
          if (unknownReply) UNKNOWN_REPLY.set(failure, unknownReply);
          reject(failure);
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
    throw fault(new Error('受管帮手不支持完整删树协议（含 temporary-files），保留原对象'), 'protocol');
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
  let actual: TreeIdentity;
  try {
    actual = treeIdentity(reply.identity);
  } catch (error) {
    throw fault(error as Error, 'identity');
  }
  if (
    Object.keys(actual).some(
      (key) => actual[key as keyof TreeIdentity] !== expected[key as keyof TreeIdentity],
    )
  )
    throw fault(new Error('回执不是原授权工作树'), 'identity');
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
  return (await readTreeUsageDetail(identity, options)).state;
}

function count(key: 'scanned' | 'failed', value: unknown): Partial<TreeUsageReading> {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? { [key]: value as number } : {};
}

/** 同 readTreeUsage；答不出 idle/busy 时带上有界的原因类别。能从原回执确定的才确定，缺证仍是 unknown。 */
export async function readTreeUsageDetail(
  identity: TreeIdentity,
  options: TreeHelperOptions = {},
): Promise<TreeUsageReading> {
  let reply: Reply;
  try {
    let args: string[];
    try {
      args = identityArgs(identity);
    } catch (error) {
      throw fault(error as Error, 'identity');
    }
    reply = await invokeTreeHelper(options, ['tree-usage', ...args]);
    assertIdentity(reply, identity);
  } catch (error) {
    const known = error && typeof error === 'object' ? FAULT.get(error) : undefined;
    const said = error && typeof error === 'object' ? UNKNOWN_REPLY.get(error) : undefined;
    if (said) {
      // 帮手答 unknown：先核回执身份，缺失或换树记身份不符；身份对得上才算帮手明确 unknown。
      try {
        assertIdentity(said, identity);
      } catch (mismatch) {
        const why = mismatch && typeof mismatch === 'object' ? FAULT.get(mismatch) : undefined;
        return { state: 'unknown', ...(why ?? { reason: 'identity' }) };
      }
      return { state: 'unknown', reason: 'helper-unknown' };
    }
    return { state: 'unknown', ...(known ?? { reason: 'unknown' }) };
  }
  if (!Number.isSafeInteger(reply.scanned) || (reply.scanned as number) <= 0 || reply.failed !== 0)
    return {
      state: 'unknown',
      reason: 'incomplete',
      ...count('scanned', reply.scanned),
      ...count('failed', reply.failed),
    };
  return reply.state === 'idle' || reply.state === 'busy'
    ? { state: reply.state }
    : { state: 'unknown', reason: 'protocol' };
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
