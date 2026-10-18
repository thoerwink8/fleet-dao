// 任务收尾与小时清扫共用的删树前置：只在成果确实可恢复后放行。
// 复杂未提交状态不靠不完整的 diff 假装保全，明确留原树，交后续接管。
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PortError, type ShotsDelivery } from '../ports.ts';
import {
  gitInTree,
  recoveryBundle,
  recoveryIdentity,
  treeLeftovers,
  type UserTree,
  verifyRecoveryBundle,
} from './user-git.ts';

async function exclusiveFile(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows 不支持 open 目录；生产 Linux 在删源之前同步目录项，不能只同步文件内容。
  if (process.platform === 'win32') return;
  const dir = await open(path, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** 返回受限存档目录；无独有成果不打包。抛错意味着调用方绝不能继续删树。 */
export async function preserveWorktree(
  t: UserTree,
  archiveDir: string,
  context: { taskId?: string; branch?: string } = {},
  shots?: ShotsDelivery,
): Promise<string | undefined> {
  const preservedPaths = async () => {
    const paths: string[] = [];
    if (shots?.outcome !== 'archived' && shots?.outcome !== 'delivered') return paths;
    for (const f of shots.files.filter((f) => f.from === 'tree')) {
      const path = `_tmp/shots/${f.path}`;
      const r = await gitInTree(t, ['hash-object', '--no-filters', '--', path], '核对已保全图片仍未变化');
      if (r.stdout.toString('utf8').trim() !== f.blob) {
        throw new PortError('WORKTREE_PRESERVED', '已保全图片之后又变化，保留原树');
      }
      paths.push(path);
    }
    return paths;
  };
  const left = await treeLeftovers(t, [], { preservedPaths: await preservedPaths() });
  if (left.kind === 'empty') return undefined;
  if (left.kind === 'not-repo' || left.dirtyCount > 0 || left.stashes > 0) {
    throw new PortError('WORKTREE_PRESERVED', '树里有未提交、未跟踪、stash 或非 Git 成果，保留原树供接管', {
      retryable: false,
      details: { dir: t.dir, leftovers: left },
    });
  }
  if (left.unpushedCount === 0) return undefined;
  const identity = await recoveryIdentity(t);
  const bytes = await recoveryBundle(t);
  await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  await chmod(archiveDir, 0o700);
  const dir = join(archiveDir, `worktree-${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  const bundle = join(dir, 'recovery.bundle');
  await exclusiveFile(bundle, bytes);
  const saved = await readFile(bundle);
  if (!saved.equals(bytes)) throw new PortError('ARCHIVE_FAILED', '落盘成果包回读不一致，保留原树');
  if (process.platform !== 'win32') {
    for (const [path, mode] of [
      [dir, 0o700],
      [bundle, 0o600],
    ] as const) {
      if (((await stat(path)).mode & 0o777) !== mode) {
        throw new PortError('ARCHIVE_FAILED', '成果存档权限不受限，保留原树');
      }
    }
  }
  await verifyRecoveryBundle(t, saved, identity);
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        ...context,
        originalPath: t.dir,
        identity,
        sha256: createHash('sha256').update(saved).digest('hex'),
        recovery:
          'git clone recovery.bundle restored; git -C restored checkout --detach <identity 首行 HEAD>',
      },
      null,
      2,
    )}\n`,
  );
  const manifestPath = join(dir, 'manifest.json');
  await exclusiveFile(manifestPath, manifest);
  if (!(await readFile(manifestPath)).equals(manifest)) {
    throw new PortError('ARCHIVE_FAILED', '成果清单回读不一致，保留原树');
  }
  await syncDirectory(dir);
  await syncDirectory(archiveDir);
  const after = await treeLeftovers(t, [], { preservedPaths: await preservedPaths() });
  if (JSON.stringify(after) !== JSON.stringify(left) || (await recoveryIdentity(t)) !== identity) {
    throw new PortError('WORKTREE_PRESERVED', '存档期间工作树成果发生变化，保留原树重新核验');
  }
  return dir;
}
