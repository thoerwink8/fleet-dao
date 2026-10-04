import type { SessionUser } from '@fleet-dao/adapters';
import type { TaskContext } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { mapped } from './mirror.ts';
import type { SessionShared } from './session-types.ts';
import type { UserTree } from './user-git.ts';

export function createTree(shared: SessionShared) {
  const { deps, trees, gh, identities, registry, log } = shared;

  const treeAs = (dir: string, user: SessionUser, prefix: string, signal?: AbortSignal): UserTree => ({
    exec: deps.exec,
    user,
    dir,
    scopePrefix: prefix,
    ...(signal ? { signal } : {}),
    ...(deps.gitBin ? { git: deps.gitBin } : {}),
    ...(deps.shBin ? { sh: deps.shBin } : {}),
  });

  const identityOf = (repo: TaskContext['repo']) => {
    const key = `${repo.owner}/${repo.name}`;
    let p = identities.get(key);
    if (!p) {
      p = mapped(() => gh.commitIdentity(repo));
      identities.set(key, p);
      p.catch(() => identities.delete(key));
    }
    return p;
  };

  /** 删这次会话的临时目录。不抛（会话的结局不受它影响）：删不掉明说没删掉，工人下次起来时 sweepTmp 再清。 */
  async function removeTmp(runId: string): Promise<void> {
    let dir: string | undefined;
    try {
      dir = trees.tmpFor(runId);
      await trees.remove(dir);
    } catch (error) {
      log('会话的临时目录没删掉（工人下次起来时再清）', {
        runId,
        ...(dir ? { dir } : {}),
        error: errMessage(error),
      });
    }
  }

  /**
   * 上一轮会话留下的临时目录：工人起来时（上一轮的会话 scope 都收了）把 _tmp 下的全清掉，这个进程里在跑的不碰。
   * 列不出来、删不掉都明说没清成（记日志），不挡工人接活：留着的只占盘，下次起来再清。回删掉了几个。
   */
  async function sweepTmp(keep: ReadonlySet<string> = new Set()): Promise<number> {
    let dirs: string[];
    try {
      dirs = await trees.listTmp();
    } catch (error) {
      log('上一轮会话留下的临时目录没清成：列不出来', { error: errMessage(error) });
      return 0;
    }
    const mine = new Set([...registry.keys(), ...keep].map((runId) => trees.tmpFor(runId)));
    let removed = 0;
    const failed: string[] = [];
    for (const dir of dirs) {
      if (mine.has(dir)) continue;
      try {
        if (!(await trees.remove(dir)).gone) removed += 1;
      } catch (error) {
        failed.push(`${dir}：${errMessage(error)}`);
      }
    }
    if (failed.length > 0) {
      log(`上一轮会话留下的临时目录有 ${failed.length} 个没删掉（下次起来再清）`, {
        failed: failed.slice(0, 10),
      });
    }
    return removed;
  }

  return { treeAs, identityOf, removeTmp, sweepTmp };
}
