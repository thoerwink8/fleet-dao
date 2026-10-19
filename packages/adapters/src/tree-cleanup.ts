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
  options.signal?.throwIfAborted();
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
  const reply = await invokeTreeHelper(options, ['cleanup-status']);
  return cleanupRows(reply);
}

function cleanupRows(reply: Reply): Reply[] {
  if (reply.state !== 'ok' || !Array.isArray(reply.rows) || reply.truncated !== false)
    throw new Error('清理事务列表不完整');
  return reply.rows as Reply[];
}

/** A missing/old/failed helper response cannot exempt a root entry from the sweep. */
export async function readCleanupNamespace(root: string, options: TreeHelperOptions = {}): Promise<Reply[]> {
  const reply = await invokeTreeHelper(options, ['cleanup-status']);
  const rows = cleanupRows(reply);
  const namespace = treeIdentity(reply.namespace);
  if (namespace.real !== `${root}/${CLEANUP_TRANSACTION_DIR}` || namespace.uid !== '0')
    throw new Error('清理事务命名空间身份不匹配');
  return rows;
}
