// 每例独占数据库和文件；迟到的清扫或清理钩子只能碰原来的 owner。
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createTestDb, type TestDb } from '@fleet-dao/db/testing';
import { type OrphanReapDeps, orphanReaper } from '../../src/real/orphan-reap.ts';
import { addTask, world } from './fixtures.ts';

type ScopeControl = { list: string; listExit: number; stopExit: number };

/** 仍经真实 Node helper 和 adapter；控制和日志路径写进该实例脚本，不读进程级环境。 */
function ownedScope(root: string) {
  const dir = join(root, `scope-${randomUUID()}`);
  mkdirSync(dir);
  const helper = join(dir, 'helper.mjs');
  const controlPath = join(dir, 'control.json');
  const logPath = join(dir, 'calls.jsonl');
  let control: ScopeControl = { list: '', listExit: 0, stopExit: 0 };
  writeFileSync(controlPath, JSON.stringify(control));
  writeFileSync(
    helper,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      `const control = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8'));`,
      'const [action, ...args] = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ action, args }) + '\\n');`,
      "if (action === 'list') { process.stdout.write(control.list); process.exitCode = control.listExit; }",
      "else if (action === 'stop') process.exitCode = control.stopExit;",
      "else throw new Error('Unknown fixture helper action');",
    ].join('\n'),
  );
  return {
    helper,
    sudo: [process.execPath],
    set(next: Partial<ScopeControl>) {
      control = { ...control, ...next };
      writeFileSync(controlPath, JSON.stringify(control));
    },
    calls(): { action: string; args: string[] }[] {
      let text: string;
      try {
        text = readFileSync(logPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

export type OrphanOwner = Awaited<ReturnType<typeof createOrphanOwner>>;

export async function createOrphanOwner() {
  const t: TestDb = await createTestDb();
  let removeDirectory: (() => void) | undefined;
  try {
    await world(t.db);
    const taskId = (await addTask(t.db)).task.id;
    const tempBase = realpathSync.native(tmpdir());
    const ownedRoot = mkdtempSync(join(tempBase, 'fleet-orphans-'));
    const initial = lstatSync(ownedRoot);
    const identity = { dev: initial.dev, ino: initial.ino, real: realpathSync.native(ownedRoot) };
    let closing = false;
    let cleanup: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();

    function track<T>(operation: Promise<T>): Promise<T> {
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    }

    function removeOwnedRoot(): void {
      const rel = relative(tempBase, resolve(ownedRoot));
      if (!rel.startsWith('fleet-orphans-') || rel.includes('/') || rel.includes('\\') || isAbsolute(rel)) {
        throw new Error('孤儿测试清理路径不在原临时根直属目录');
      }
      const current = lstatSync(ownedRoot);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        realpathSync.native(ownedRoot) !== identity.real
      ) {
        throw new Error('孤儿测试目录身份已变化，拒绝删除替身');
      }
      rmSync(ownedRoot, { recursive: true, force: true });
    }
    removeDirectory = removeOwnedRoot;

    return {
      t,
      root: ownedRoot,
      taskId,
      scope() {
        if (closing) throw new Error('孤儿测试 owner 已收尾，不再创建 helper');
        return ownedScope(ownedRoot);
      },
      reaper(deps: Omit<OrphanReapDeps, 'db'>) {
        const run = orphanReaper({ ...deps, db: t.db });
        return () => {
          if (closing) return Promise.reject(new Error('孤儿测试 owner 已收尾，不再启动清扫'));
          return track(run());
        };
      },
      delayed(fn: () => void): () => void {
        // 已启动的 sweep 仍持有本 owner 的库、目录和 helper；尚未开始的回调在收尾后失效。
        return () => {
          if (!closing) fn();
        };
      },
      close(): Promise<void> {
        if (!cleanup) {
          closing = true;
          cleanup = (async () => {
            // 钩子自身超时也不把这些资源交给下一例；隔离来自固定 owner，不靠此等待及时结束。
            while (pending.size > 0) await Promise.allSettled([...pending]);
            try {
              await t.close();
            } finally {
              removeOwnedRoot();
            }
          })();
        }
        return cleanup;
      },
    };
  } catch (error) {
    await t.close();
    // 准备失败时根目录尚未交给用例，也没有后台工作。
    removeDirectory?.();
    throw error;
  }
}
