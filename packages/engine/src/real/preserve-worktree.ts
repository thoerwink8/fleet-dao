// 任务收尾与小时清扫共用的删树前置：只在成果确实可恢复后放行。
// 干净的未发布提交打完整包；复杂未提交状态打受限快照和受管回执。
// 独立恢复对上、原树身份没变、并且删除前再次确认没人用，清理入口才继续。旁边已有的备份不是回执。
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PortError, type ShotsDelivery } from '../ports.ts';
import {
  archiveMode,
  assertArchiveContainer,
  assertNoTreeProcess,
  assertPeopleIdle,
  assertTreeInside,
  gitOperationState,
  holdCleanupLock,
  type IdleAnswer,
  locateTree,
  makeArchiveDir,
  type ProcLook,
  preserveComplexWorktree,
  readArchiveFile,
  recheckNoUnique,
  recheckPreservedArchive,
  syncDirectory,
  type TreePlace,
  writeExclusiveArchive,
} from './complex-preserve.ts';
import {
  gitInTree,
  recoveryBundle,
  recoveryIdentity,
  treeLeftovers,
  type UserTree,
  verifyRecoveryBundle,
} from './user-git.ts';

export interface PreserveContext {
  taskId?: string;
  branch?: string;
  /** 工作根。复杂成果没给它，或者树不在这下面，就留树。 */
  workRoot?: string;
  /** 删除前再问有没有任务或会话在用。没给、答不清，复杂成果留树。 */
  confirmIdle?: () => Promise<IdleAnswer>;
  /** 看进程 cwd 的口子。生产不给，用 /proc。 */
  processLook?: ProcLook;
}

/** 已交付或已归档的图片：按 blob 现核，对上的才从成果清单里拿掉。不信回执里写的路径。 */
async function preservedShotPaths(t: UserTree, shots?: ShotsDelivery): Promise<string[]> {
  const paths: string[] = [];
  if (shots?.outcome !== 'archived' && shots?.outcome !== 'delivered') return paths;
  for (const f of shots.files.filter((file) => file.from === 'tree')) {
    const path = `_tmp/shots/${f.path}`;
    const r = await gitInTree(t, ['hash-object', '--no-filters', '--', path], '核对已保全图片仍未变化');
    if (r.stdout.toString('utf8').trim() !== f.blob) {
      throw new PortError('WORKTREE_PRESERVED', '已保全图片之后又变化，保留原树');
    }
    paths.push(path);
  }
  return paths;
}

function kept(message: string, dir: string): PortError {
  return new PortError('WORKTREE_PRESERVED', message, { retryable: false, details: { dir } });
}

/** 返回受限存档目录；无独有成果不打包。抛错意味着调用方绝不能继续删树。 */
export async function preserveWorktree(
  t: UserTree,
  archiveDir: string,
  context: PreserveContext = {},
  shots?: ShotsDelivery,
): Promise<string | undefined> {
  const shotPaths = () => preservedShotPaths(t, shots);
  const left = await treeLeftovers(t, [], { preservedPaths: await shotPaths() });
  if (left.kind === 'empty') return undefined;
  // 没并完的合并、挑拣、变基等状态只在 git 目录里：工作区干净也不能走只带引用的成果包
  const operations = left.kind === 'repo' ? await gitOperationState(t) : [];
  const complex = left.kind === 'repo' && (left.dirtyCount > 0 || left.stashes > 0 || operations.length > 0);
  const gateReady = context.workRoot !== undefined && context.confirmIdle !== undefined;
  const why = '树里有未提交、未跟踪、stash、没做完的 git 操作或非 Git 成果，保留原树供接管';
  if (left.kind === 'not-repo' || (complex && !gateReady)) throw kept(why, t.dir);
  if (complex) {
    const workRoot = context.workRoot;
    const confirmIdle = context.confirmIdle;
    if (!workRoot || !confirmIdle) throw kept(why, t.dir);
    await assertArchiveContainer(archiveDir);
    return preserveComplexWorktree(
      t,
      archiveDir,
      {
        ...(context.taskId ? { taskId: context.taskId } : {}),
        ...(context.branch ? { branch: context.branch } : {}),
        workRoot,
        confirmIdle,
        ...(context.processLook ? { processLook: context.processLook } : {}),
      },
      await shotPaths(),
    );
  }
  if (left.kind !== 'repo' || left.unpushedCount === 0) return undefined;
  const identity = await recoveryIdentity(t);
  const bytes = await recoveryBundle(t);
  await assertArchiveContainer(archiveDir);
  const dir = join(archiveDir, `worktree-${randomUUID()}`);
  await makeArchiveDir(dir);
  const bundle = join(dir, 'recovery.bundle');
  await writeExclusiveArchive(bundle, bytes);
  const saved = await readArchiveFile(bundle);
  if (!saved.equals(bytes)) throw new PortError('ARCHIVE_FAILED', '落盘成果包回读不一致，保留原树');
  if (process.platform !== 'win32') {
    for (const [path, mode] of [
      [dir, 0o700],
      [bundle, 0o600],
    ] as const) {
      if ((await archiveMode(path)) !== mode) {
        throw new PortError('ARCHIVE_FAILED', '成果存档权限不受限，保留原树');
      }
    }
  }
  await verifyRecoveryBundle(t, saved, identity);
  const { processLook: _look, ...recorded } = context;
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        ...recorded,
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
  await writeExclusiveArchive(manifestPath, manifest);
  if (!(await readArchiveFile(manifestPath)).equals(manifest)) {
    throw new PortError('ARCHIVE_FAILED', '成果清单回读不一致，保留原树');
  }
  await syncDirectory(dir);
  await syncDirectory(archiveDir);
  const after = await treeLeftovers(t, [], { preservedPaths: await shotPaths() });
  if (
    JSON.stringify(after) !== JSON.stringify(left) ||
    (await recoveryIdentity(t)) !== identity ||
    (await gitOperationState(t)).length > 0
  ) {
    throw new PortError('WORKTREE_PRESERVED', '存档期间工作树成果发生变化，保留原树重新核验');
  }
  return dir;
}

/**
 * 清理入口：锁住这棵树，保全，删除前再核对回执和现场，然后只删调用方给出的这一个目录。
 * 回执里的路径不拿来删。核不上就留树。
 */
export async function preserveThenRemove(
  t: UserTree,
  archiveDir: string,
  context: PreserveContext & { workRoot: string },
  shots: ShotsDelivery | undefined,
  remove: (identity: TreePlace) => Promise<{ gone: boolean }>,
): Promise<{ gone: boolean; archivedTo?: string }> {
  await assertArchiveContainer(archiveDir);
  const place = await locateTree(t);
  assertTreeInside(context.workRoot, place);
  const release = await holdCleanupLock(archiveDir, place);
  try {
    const archivedTo = await preserveWorktree(t, archiveDir, context, shots);
    const preserved = await preservedShotPaths(t, shots);
    const again = await locateTree(t);
    if (
      again.dev !== place.dev ||
      again.ino !== place.ino ||
      again.real !== place.real ||
      again.uid !== place.uid ||
      again.lex !== place.lex
    ) {
      throw kept('删除前工作树身份变了，旧回执作废，保留原树', t.dir);
    }
    assertTreeInside(context.workRoot, again);
    if (archivedTo) {
      await recheckPreservedArchive(t, archivedTo, context, again, preserved);
    } else {
      if (context.confirmIdle) await assertPeopleIdle(context.confirmIdle, '删除前');
      await recheckNoUnique(t, preserved);
    }
    // 删除必经点：干净树、干净未推提交也现核进程 cwd，库里没登记会话不等于没人用
    await assertNoTreeProcess(t, again, context.processLook);
    const result = await remove(place);
    return { gone: result.gone, ...(archivedTo ? { archivedTo } : {}) };
  } finally {
    await release();
  }
}
