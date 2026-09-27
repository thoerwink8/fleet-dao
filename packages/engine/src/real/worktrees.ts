// 会话的目录在哪、归谁（design 十四：/var/lib/fleet-work/<仓>/<需求号>-<子任务>/，归会话用户、700；还不归它的
// 由 fleet-agent-scope 建或改属主）。引擎只看属主（stat 目录本身，不进去）、叫助手建 / 改属主 / 删，
// 目录里的东西一律由会话用户自己碰（user-git.ts）。
// 根下还有两样不是工作树的：探针的工作目录 _route-probe/<会话用户>（route-probe.ts），每个会话自己的临时目录
// _tmp/<会话编号>（会话的 TMPDIR，会话结束就删，sessions.ts）。仓的目录是 <owner>_<name>，打头的是字母数字，撞不上这两个。

import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { adoptWorktree, removeWorktreeDir, SESSION_USERS, type SessionUser } from '@fleet-dao/adapters';
import type { Repo, StageKind } from '@fleet-dao/shared';
import { PortError } from '../ports.ts';

export const DEFAULT_WORK_ROOT = '/var/lib/fleet-work';

/**
 * 会话临时目录的上一级（在工作树的根下）。路径要短：会话里的工具（tsx 之类）在 TMPDIR 下建 unix 套接字，
 * 整条路径超过 107 个字节就建不了；<根>/_tmp/<会话编号> 在法国是 61 个字节。
 */
export const SESSION_TMP_DIR = '_tmp';

export interface WorkTrees {
  root: string;
  /** 子任务的工作树：<root>/<owner>_<name>/<分支去掉 fleet/ 前缀>。 */
  treeFor(repo: Pick<Repo, 'owner' | 'name'>, branch: string): string;
  /** 分诊、文档、方案、审查的检出副本：<root>/<owner>_<name>/<需求号>.<阶段>[.<子任务>]（点号不会出现在子任务名里）。 */
  scratchFor(
    repo: Pick<Repo, 'owner' | 'name'>,
    issueNumber: number,
    stage: StageKind,
    subtaskKey?: string,
  ): string;
  /**
   * 这次会话自己的临时目录（会话的 TMPDIR）：<root>/_tmp/<会话编号>。不在工作树里（git add -A 带不进去），和工作树一样由
   * 帮手建成会话用户的、删也经帮手。
   */
  tmpFor(runId: string): string;
  /** _tmp 下现有的会话临时目录（完整路径）；_tmp 还没建过回空。读不了明确报错，不当成一个都没有。 */
  listTmp(): Promise<string[]>;
  /** 目录归哪个会话用户；不在回 null。归了别人（不是会话用户）明确报错。 */
  ownerOf(dir: string): Promise<SessionUser | null>;
  /** 交给这个会话用户（不在就建）。 */
  adopt(dir: string, user: SessionUser): Promise<void>;
  remove(dir: string): Promise<{ gone: boolean }>;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function segment(value: string, what: string): string {
  if (!SEGMENT.test(value) || value.includes('..')) {
    throw new PortError('BAD_INPUT', `${what} 放不进目录名：${value}`, { retryable: false });
  }
  return value;
}

/** GitHub 的用户名、组织名里没有下划线：<owner>_<name> 不会两个仓撞成一个名字。 */
function repoDir(root: string, repo: Pick<Repo, 'owner' | 'name'>): string {
  return `${root}/${segment(repo.owner, '仓的主人')}_${segment(repo.name, '仓名')}`;
}

export function layout(root: string): Pick<WorkTrees, 'root' | 'treeFor' | 'scratchFor' | 'tmpFor'> {
  return {
    root,
    tmpFor(runId) {
      return `${root}/${SESSION_TMP_DIR}/${segment(runId, '会话编号')}`;
    },
    treeFor(repo, branch) {
      const leaf = branch.startsWith('fleet/') ? branch.slice('fleet/'.length) : branch;
      if (leaf.includes('/'))
        throw new PortError('BAD_INPUT', `分支名放不进目录名：${branch}`, { retryable: false });
      return `${repoDir(root, repo)}/${segment(leaf, '分支名')}`;
    },
    scratchFor(repo, issueNumber, stage, subtaskKey) {
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new PortError('BAD_INPUT', `需求号不对：${issueNumber}`, { retryable: false });
      }
      const tail = subtaskKey ? `.${segment(subtaskKey, '子任务名')}` : '';
      return `${repoDir(root, repo)}/${issueNumber}.${stage}${tail}`;
    },
  };
}

/** /etc/passwd 里会话用户的 uid（引擎读得到 passwd，读不到会话用户的家）。缺了明确报错。 */
export function sessionUserUids(passwd = readFileSync('/etc/passwd', 'utf8')): Map<number, SessionUser> {
  const out = new Map<number, SessionUser>();
  for (const line of passwd.split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && uid && (SESSION_USERS as readonly string[]).includes(name))
      out.set(Number(uid), name as SessionUser);
  }
  for (const user of SESSION_USERS) {
    if (![...out.values()].includes(user))
      throw new Error(`/etc/passwd 里没有会话用户 ${user}（france.sh 没跑过？）`);
  }
  return out;
}

export interface HelperWorkTreesOptions {
  root?: string;
  helper?: string;
  sudo?: readonly string[];
  /** uid → 会话用户；不给就读 /etc/passwd。 */
  uids?: Map<number, SessionUser>;
}

/** 生产：属主按 stat 看，建、改属主、删都经 fleet-agent-scope（root）。 */
export function helperWorkTrees(options: HelperWorkTreesOptions = {}): WorkTrees {
  const root = options.root ?? DEFAULT_WORK_ROOT;
  let uids = options.uids;
  const helperOpts = {
    ...(options.helper ? { helper: options.helper } : {}),
    ...(options.sudo ? { sudo: options.sudo } : {}),
  };
  return {
    ...layout(root),
    // _tmp 由帮手建成 root:root 755（adopt 建中间各级的规矩），引擎读得了；里面每一个归会话用户、700，引擎不进去。
    async listTmp() {
      const base = `${root}/${SESSION_TMP_DIR}`;
      try {
        return (await readdir(base)).map((name) => `${base}/${name}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new PortError('WORKTREE_UNREADABLE', `看不了 ${base} 里有哪些会话临时目录：${String(error)}`, {
          retryable: true,
        });
      }
    },
    async ownerOf(dir) {
      let uid: number;
      try {
        uid = (await stat(dir)).uid;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new PortError('WORKTREE_UNREADABLE', `看不了 ${dir} 归谁：${String(error)}`, {
          retryable: true,
        });
      }
      uids ??= sessionUserUids();
      const user = uids.get(uid);
      if (!user) {
        throw new PortError('WORKTREE_FOREIGN', `${dir} 归 uid ${uid}，不是会话用户：不碰`, {
          retryable: false,
        });
      }
      return user;
    },
    async adopt(dir, user) {
      const r = await adoptWorktree({ dir, user, ...helperOpts });
      if (r.ok) return;
      throw new PortError('ADOPT_FAILED', `把 ${dir} 交给 ${user} 没成：${r.detail}`, {
        retryable: r.code !== 'usage',
        details: { exitCode: r.exitCode },
      });
    },
    async remove(dir) {
      const r = await removeWorktreeDir({ dir, ...helperOpts });
      if (r.ok) return { gone: r.gone };
      throw new PortError('REMOVE_FAILED', `删 ${dir} 没成：${r.detail}`, {
        retryable: r.code !== 'usage',
        details: { exitCode: r.exitCode },
      });
    },
  };
}
