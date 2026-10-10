// 临时目录：在系统临时目录下，不在仓里。夹具拷进去；要真仓的题，用 git archive <固定提交> 导一份快照（不带 .git，不建工作树）。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalCase } from './types.ts';
import { PACKAGE_DIR, REPO_ROOT } from './types.ts';

export interface Workspace {
  dir: string;
  cleanup: () => void;
}

export function caseDirOf(c: Pick<EvalCase, 'scenario' | 'name'>): string {
  return join(PACKAGE_DIR, 'cases', c.scenario, c.name);
}

function newRoot(tmpRoot: string | undefined): { root: string; dir: string; cleanup: () => void } {
  // 先转成真路径再交给会话当工作目录：Windows 的 tmpdir() 是 8.3 短名（C:\Users\ADMINI~1\…），
  // claude 认它不是自己的工作目录，dontAsk 下 Edit、Write 和带这个路径的 Bash 一律拒，要改文件的题就全白跑（#1641）。
  const root = realpathSync.native(mkdtempSync(join(tmpRoot ?? tmpdir(), 'agent-eval-')));
  const dir = join(root, 'work');
  mkdirSync(dir);
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 把 cases/<场景>/<题>/workspace 拷进临时目录。hidden/ 不拷。 */
export function prepareFixture(c: EvalCase, tmpRoot?: string): Workspace {
  const src = join(caseDirOf(c), 'workspace');
  if (!existsSync(src)) throw new Error(`夹具目录不存在：${src}`);
  const w = newRoot(tmpRoot);
  cpSync(src, w.dir, { recursive: true });
  return { dir: w.dir, cleanup: w.cleanup };
}

/** git archive <提交> 导一份快照。提交不在本地（浅克隆）、git 或 tar 起不来都抛错。 */
export function prepareRepoSnapshot(
  commit: string,
  repoRoot: string = REPO_ROOT,
  tmpRoot?: string,
): Workspace {
  const w = newRoot(tmpRoot);
  try {
    const tarName = 'snapshot.tar';
    const archive = spawnSync(
      'git',
      ['-C', repoRoot, 'archive', '--format=tar', '-o', join(w.root, tarName), commit],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    if (archive.error || archive.status !== 0) {
      throw new Error(`git archive ${commit} 失败：${archive.error?.message ?? archive.stderr.trim()}`);
    }
    // tar 用相对路径：GNU tar 会把 C:\ 开头的路径当成远程主机名。
    const untar = spawnSync('tar', ['-xf', tarName, '-C', 'work'], {
      cwd: w.root,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (untar.error || untar.status !== 0) {
      throw new Error(`tar 解包失败：${untar.error?.message ?? untar.stderr.trim()}`);
    }
    rmSync(join(w.root, tarName), { force: true });
  } catch (e) {
    w.cleanup();
    throw e;
  }
  return { dir: w.dir, cleanup: w.cleanup };
}

export function prepareWorkspace(c: EvalCase, tmpRoot?: string): Workspace {
  return c.source.kind === 'repo'
    ? prepareRepoSnapshot(c.source.commit, REPO_ROOT, tmpRoot)
    : prepareFixture(c, tmpRoot);
}
