// 会话目录里的 git，一律以会话用户的身份跑（经 exec.ts）：从 bundle 建树、看头和改动、把新提交打成 bundle 交出来、
// 并主线后快进。git 没跑成一律抛 PortError（带白话原因），不拿空字符串、空列表冒充「没有改动」。

import path from 'node:path';
import type { SessionUser } from '@fleet-dao/adapters';
import { PortError } from '../ports.ts';
import { describeFailure, type UserCommandResult, type UserExec } from './exec.ts';

/** 老会话把结论文件写在工作树的这个目录里（已经没人写了）；树里还留着的别当成「剩着的改动」（DISPOSABLE 里一条）。 */
export const OUT_DIR = '.fleet-out';

export const GIT = '/usr/bin/git';
export const SH = '/bin/sh';

/** 在哪个目录、以谁的身份跑。scopePrefix 拼 scope 编号：同一时刻不许重复，所以每条命令再加序号。 */
export interface UserTree {
  exec: UserExec;
  user: SessionUser;
  dir: string;
  scopePrefix: string;
  git?: string;
  sh?: string;
  signal?: AbortSignal;
}

let seq = 0;
function scopeIdFor(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)}-g${seq}`;
}

const GIT_ENV = { LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0' };

async function run(
  t: UserTree,
  argv: string[],
  options: { stdin?: Buffer; timeoutMs?: number } = {},
): Promise<UserCommandResult> {
  return t.exec({
    user: t.user,
    cwd: t.dir,
    argv,
    ...(options.stdin ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(t.signal ? { signal: t.signal } : {}),
    scopeId: scopeIdFor(t.scopePrefix),
    env: GIT_ENV,
  });
}

async function git(
  t: UserTree,
  args: string[],
  what: string,
  options: { stdin?: Buffer; timeoutMs?: number; allow?: number[] } = {},
): Promise<UserCommandResult> {
  // 中文文件名（specs/<号>-<短名>/方案.md……）原样列出：git 默认把非 ASCII 的字节转成 "\346\226…" 再加引号，
  // 改动清单就和仓里的路径对不上（方案、结果算成没提交）
  const r = await run(t, [t.git ?? GIT, '-c', 'core.quotePath=false', ...args], options);
  if (r.code === 0 || (r.code !== null && options.allow?.includes(r.code))) return r;
  throw new PortError('GIT_FAILED', describeFailure(what, r), {
    retryable: !r.aborted,
    details: { user: t.user, dir: t.dir },
  });
}

/** 以会话用户在树里跑一条命令，原样交回、不判退出码（shots.ts 清点、读图片用）。 */
export function runInTree(
  t: UserTree,
  argv: string[],
  options: { stdin?: Buffer; timeoutMs?: number } = {},
): Promise<UserCommandResult> {
  return run(t, argv, options);
}

/** 以会话用户在树里跑 git：没跑成（退出码不在 allow 里）抛 PortError。 */
export function gitInTree(
  t: UserTree,
  args: string[],
  what: string,
  options: { stdin?: Buffer; timeoutMs?: number; allow?: number[] } = {},
): Promise<UserCommandResult> {
  return git(t, args, what, options);
}

const text = (r: UserCommandResult) => r.stdout.toString('utf8');
const lines = (r: UserCommandResult) =>
  text(r)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);

const SHA = /^[0-9a-f]{40}$/;

function assertSha(sha: string, what: string): void {
  if (!SHA.test(sha))
    throw new PortError('BAD_INPUT', `${what} 不是完整的提交号：${sha}`, { retryable: false });
}

/** `rev-parse` 退出 128 且是这句时，才是「这里和祖先都没有仓」。别的 128（比如归属可疑）是没看成。 */
const NOT_A_REPO = /not a git repository/;

/**
 * 两条路径是不是同一个目录。先按当前系统（或测试注入的平台）做词法规范化：`.`、`..`、尾部分隔符；
 * Windows 上再去掉 `\\?\`、折大小写。这里只做词法比较；物理路径由 pathsAre 经会话用户解析，
 * 引擎身份不能遍历会话的700目录。
 * platform 只给测试注入另一套路径规则；生产不传。
 */
export function repoDirectoryKey(input: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return winRepoPath(input).toLowerCase();
  }
  const physical = path.posix.resolve(input);
  return physical.length > 1 ? physical.replace(/\/+$/, '') : physical;
}

function winRepoPath(input: string): string {
  let p = input.trim().replace(/\//g, '\\');
  if (p.slice(0, 8).toUpperCase() === '\\\\?\\UNC\\') p = `\\\\${p.slice(8)}`;
  else if (p.slice(0, 4).toUpperCase() === '\\\\?\\') p = p.slice(4);
  p = path.win32.resolve(p);
  if (p.length > 3) p = p.replace(/[\\/]+$/, '');
  return p;
}

type RepoPlace =
  | { kind: 'none' }
  | { kind: 'checkout' }
  | { kind: 'bare' }
  | { kind: 'ancestor'; found: string };

function placeError(t: UserTree, message: string, retryable = true): PortError {
  return new PortError('GIT_FAILED', message, {
    retryable,
    details: { user: t.user, dir: t.dir },
  });
}

async function pathsMatch(t: UserTree, gitPath: string): Promise<boolean> {
  const other = path.isAbsolute(gitPath) ? gitPath : path.resolve(t.dir, gitPath);
  return pathsAre(t.dir, other, t);
}

/**
 * 这个目录自己的仓边界，不是 git 向上摸到的祖先。
 * - none：这里和祖先都没有仓。
 * - checkout：非 bare 的工作树顶层（含 linked worktree，.git 可以是文件）。
 * - bare：这个目录本身就是 bare 仓。
 * - ancestor：git 找到了仓，但顶层或 git 目录不是这里（父仓里的空子目录、bare 仓里的子目录、站在 .git 里）。
 * 归属命令没跑成（不是「没有仓」）就抛，不当成 none。
 */
async function repoPlace(t: UserTree): Promise<RepoPlace> {
  const bin = t.git ?? GIT;
  const probed = await run(t, [bin, 'rev-parse', '--is-bare-repository', '--is-inside-work-tree']);
  if (probed.code === 128 && NOT_A_REPO.test(probed.stderr)) return { kind: 'none' };
  if (probed.code !== 0) throw placeError(t, describeFailure('看这个目录归哪一个仓', probed));
  const [bare, inside] = text(probed)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if ((bare !== 'true' && bare !== 'false') || (inside !== 'true' && inside !== 'false')) {
    throw placeError(t, `看这个目录归哪一个仓：输出认不出（${text(probed).trim().slice(0, 80) || '空的'}）`);
  }
  if (inside === 'true') {
    const top = await run(t, [bin, 'rev-parse', '--show-toplevel']);
    if (top.code !== 0) throw placeError(t, describeFailure('看这个目录归哪一个仓', top));
    const found = text(top).trim();
    if (!found) throw placeError(t, '看这个目录归哪一个仓：输出认不出（空的）');
    if (await pathsMatch(t, found)) return { kind: 'checkout' };
    return { kind: 'ancestor', found };
  }
  const located = await run(t, [bin, 'rev-parse', '--absolute-git-dir']);
  if (located.code !== 0) throw placeError(t, describeFailure('看这个目录归哪一个仓', located));
  const found = text(located).trim();
  if (!found) throw placeError(t, '看这个目录归哪一个仓：输出认不出（空的）');
  // bare 的目录本身就是 git 目录。工作树的 .git、bare 里面的子目录都不是目标自己的边界。
  if (bare === 'true' && (await pathsMatch(t, found))) return { kind: 'bare' };
  return { kind: 'ancestor', found };
}

/**
 * 元数据是不是这份仓自己的（git 目录和共用目录是同一处）。
 * linked worktree 的 .git 是文件，检出根仍是它自己，但配置和引用写进主仓的共用目录。
 * 这只约束建树写入；不用「.git 必须是目录」来认仓（独立的 gitfile、submodule 共用目录和 git 目录相同）。
 */
async function metadataIsOwn(t: UserTree): Promise<boolean> {
  const bin = t.git ?? GIT;
  const gitDir = await run(t, [bin, 'rev-parse', '--absolute-git-dir']);
  if (gitDir.code !== 0) throw placeError(t, describeFailure('看这个目录的 git 目录', gitDir));
  const common = await run(t, [bin, 'rev-parse', '--git-common-dir']);
  if (common.code !== 0) throw placeError(t, describeFailure('看这个目录的共用 git 目录', common));
  const gitDirPath = text(gitDir).trim();
  const commonPath = text(common).trim();
  if (!gitDirPath || !commonPath) throw placeError(t, '看这个目录的 git 目录：输出认不出（空的）');
  const commonAbs = path.isAbsolute(commonPath) ? commonPath : path.resolve(t.dir, commonPath);
  return pathsAre(gitDirPath, commonAbs, t);
}

/** 同一套 Node 原生解析跨平台可用，但必须经现有 UserExec 在会话身份内读，不能在引擎进程读私有目录。 */
async function pathsAre(a: string, b: string, t: UserTree): Promise<boolean> {
  const result = await run(t, [
    process.execPath,
    '--input-type=commonjs',
    '-e',
    'console.log(JSON.stringify(process.argv.slice(1).map(p => require("node:fs").realpathSync.native(p))))',
    a,
    b,
  ]);
  if (result.code !== 0 || result.timedOut || result.aborted || result.spawnError) {
    throw placeError(t, describeFailure('看这个目录的物理路径', result), !result.aborted);
  }
  try {
    const paths: unknown = JSON.parse(text(result));
    if (
      !Array.isArray(paths) ||
      paths.length !== 2 ||
      paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))
    ) {
      throw new Error('物理路径输出认不出');
    }
    return repoDirectoryKey(paths[0]) === repoDirectoryKey(paths[1]);
  } catch (error) {
    throw placeError(
      t,
      `看这个目录的 git 目录没看成（${error instanceof Error ? error.message : '读不了路径'}）`,
    );
  }
}

/**
 * 建树写入前的归属：没有仓（可以在这里 init），或这份目录自己的仓且元数据不和别的仓共用。
 * 祖先对不上、共用元数据、归属没读成，都在这里停，调用方还没写。
 */
async function writableTree(t: UserTree, what: string): Promise<'none' | 'own'> {
  const place = await repoPlace(t);
  if (place.kind === 'ancestor') {
    throw placeError(t, `${what}：这个目录在别的仓里（Git 认的是 ${place.found}），不能往那里写`, false);
  }
  if (place.kind === 'none') return 'none';
  if (!(await metadataIsOwn(t))) {
    throw placeError(t, `${what}：这个检出和别的仓共用元数据，不能在这里改配置或引用`, false);
  }
  return 'own';
}

/**
 * 目标目录本身是不是一个仓的边界：工作树顶层，或这个目录就是 bare 仓。
 * 父仓里的空子目录不算——`rev-parse --git-dir` 成功只说明处在某个仓或工作树里，git 会向上找到父仓。
 * linked worktree（.git 是文件）的顶层就是它自己，算有仓。bare 算有仓；是不是检出由 hasCheckout 另判。
 */
export async function hasRepo(t: UserTree): Promise<boolean> {
  const place = await repoPlace(t);
  return place.kind === 'checkout' || place.kind === 'bare';
}

/**
 * 目标目录本身是不是一份非 bare 的检出根，并且 HEAD 解析得出提交。
 * 在父仓里面、bare 仓、或 init 了还没有提交的空仓，都不是。建树是先 init 再从 bundle 取、再检出，取包半截失败的树
 * 只有一个空仓（HEAD 指着还不存在的分支）——光看仓边界在不在会把它当成建好了，会话就在空树里干活。
 * linked worktree 只要顶层是它自己、HEAD 有效，就是。
 */
export async function hasCheckout(t: UserTree): Promise<boolean> {
  const place = await repoPlace(t);
  if (place.kind !== 'checkout') return false;
  const r = await run(t, [t.git ?? GIT, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (r.code === 0) return true;
  if (r.code === 1 || r.code === 128) return false;
  throw new PortError('GIT_FAILED', describeFailure('看仓里检出了没有', r), { retryable: true });
}

export interface Identity {
  name: string;
  email: string;
}

/** 用目标仓的真实对象闭包核 bundle；只读对象/引用，临时文件由会话身份创建并清理。 */
export async function verifyBundle(t: UserTree, bundle: Buffer): Promise<boolean> {
  if ((await writableTree(t, '核 bundle 依赖')) === 'none') {
    throw placeError(t, '核 bundle 依赖：目标还不是仓', false);
  }
  t.signal?.throwIfAborted();
  const script =
    'd="$("$1" rev-parse --git-dir)" || exit 70; ' +
    'f="$(mktemp "$d/fleet-verify-XXXXXX")" || exit 70; ' +
    'trap \'rm -f -- "$f"\' EXIT; ' +
    'cat > "$f" || exit 70; "$1" bundle verify "$f"';
  const r = await run(t, [t.sh ?? SH, '-c', script, 'sh', t.git ?? GIT], {
    stdin: bundle,
    timeoutMs: 120_000,
  });
  if (r.aborted || r.timedOut || r.spawnError || r.code === null || r.code === 70) {
    throw new PortError('GIT_FAILED', describeFailure('核 bundle 依赖', r), { retryable: !r.aborted });
  }
  return r.code === 0;
}

/**
 * 从 bundle 取提交进目录里的仓：没有仓先 init（设好提交身份——会话的提交挂在「干活的」机器人名下；关掉自动维护）。
 * bundle 经标准输入进来，会话用户在自己的 .git 里落成临时文件再 fetch，fetch 完删掉。取完回 refs/fleet/incoming 的头。
 */
export async function fetchBundle(
  t: UserTree,
  bundle: Buffer,
  ref: string,
  options: { identity?: Identity } = {},
): Promise<string> {
  if (!/^refs\/fleet\/[A-Za-z0-9/_.-]+$/.test(ref)) {
    throw new PortError('BAD_INPUT', `bundle 里的引用名不对：${ref}`, { retryable: false });
  }
  // 先核对归属再 init / 改配置 / fetch。父仓里的空目录这里还不是仓，但不能 init：那会写进父仓的工作树。
  const own = await writableTree(t, '从 bundle 取提交');
  const fresh = own === 'none';
  if (fresh) await git(t, ['init', '-q'], '建仓');
  // 给了身份就每次都设（幂等）：建了仓、没设好身份就断了的树，同一个 runId 重试时也补得上
  if (options.identity) {
    await git(t, ['config', 'user.name', options.identity.name], '设提交身份');
    await git(t, ['config', 'user.email', options.identity.email], '设提交身份');
  }
  if (fresh || options.identity) {
    await git(t, ['config', 'commit.gpgsign', 'false'], '设提交身份');
    // 会话的树用完就删，不许 git 在后台做自动维护：git 2.54 起 fetch、merge、commit 之后默认做几何重打包，而且脱离
    // 前台在后台跑（maintenance.autoDetach 默认开）——收树、删树时它还在往 .git/objects 里写，删树报 ENOTEMPTY；
    // 也白占会话 scope 的 CPU 和内存。gc.auto=0 管还没有 maintenance 的老 git（直接跑 gc --auto）。
    await git(t, ['config', 'maintenance.auto', 'false'], '关掉自动维护');
    await git(t, ['config', 'gc.auto', '0'], '关掉自动维护');
  }
  const script =
    'f="$(git rev-parse --git-dir)/fleet-incoming.bundle" && cat > "$f" && ' +
    'git fetch --no-tags -q "$f" "+$1:refs/fleet/incoming"; rc=$?; rm -f "$f"; exit $rc';
  const r = await run(t, [t.sh ?? SH, '-c', script, 'sh', ref], { stdin: bundle, timeoutMs: 300_000 });
  if (r.code !== 0)
    throw new PortError('GIT_FAILED', describeFailure('从 bundle 取提交', r), { retryable: true });
  return headOfRef(t, 'refs/fleet/incoming');
}

async function headOfRef(t: UserTree, ref: string): Promise<string> {
  const r = await git(t, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], `读 ${ref}`);
  const sha = text(r).trim();
  assertSha(sha, ref);
  return sha;
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** 会话树里主线的引用名：refs/remotes/origin/<主线分支>，git 里写 origin/<主线分支> 就认得。 */
export function mainlineRef(defaultBranch: string): string {
  if (!BRANCH.test(defaultBranch) || defaultBranch.includes('..') || defaultBranch.endsWith('.lock')) {
    throw new PortError('BAD_INPUT', `主线分支名不对：${defaultBranch}`, { retryable: false });
  }
  return `refs/remotes/origin/${defaultBranch}`;
}

/** 树里钉的主线头（origin/<主线> 解析出的提交）；没钉回 null。git 没跑成照抛，不当成没钉。 */
async function pinnedMainline(t: UserTree, defaultBranch: string): Promise<string | null> {
  const ref = mainlineRef(defaultBranch);
  const r = await run(t, [t.git ?? GIT, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (r.code === 1) return null;
  if (r.code !== 0) {
    throw new PortError('GIT_FAILED', describeFailure(`读 origin/${defaultBranch}`, r), {
      retryable: !r.aborted,
      details: { user: t.user, dir: t.dir },
    });
  }
  const sha = text(r).trim();
  assertSha(sha, `origin/${defaultBranch}`);
  return sha;
}

/** 树里钉没钉主线。 */
export async function hasMainline(t: UserTree, defaultBranch: string): Promise<boolean> {
  return (await pinnedMainline(t, defaultBranch)) !== null;
}

/**
 * 把「主线」钉在树里的一个主线提交上。树是从 bundle 建的、没有远端，git diff origin/main...HEAD 和 pnpm test:changed
 * （和 origin/main 比改了什么，specs/164-会话内存与交活测试/）都靠这个引用；没有它 test:changed 明确报「认不出 origin/main」。
 * 三个点的比法只看分叉点：钉得比分支并进来的主线旧，会把并进来的主线改动也算成这次改的（多跑测试，不会少跑），
 * 所以引擎每次把新的主线取进树里都跟着重钉。sha 必须已经在树里（git 拒绝把引用指到没有的提交上，抛 GIT_FAILED）。
 */
export async function pinMainline(t: UserTree, defaultBranch: string, sha: string): Promise<void> {
  assertSha(sha, '主线的提交');
  const ref = mainlineRef(defaultBranch);
  const what = `把 origin/${defaultBranch} 钉到 ${sha.slice(0, 7)}`;
  // 不经过 hasRepo。目录在父仓里时 update-ref 会改父仓的引用，所以写入前单独拒。
  const own = await writableTree(t, what);
  if (own === 'none') throw placeError(t, `${what}：这个目录还不是仓`, false);
  await git(t, ['update-ref', ref, sha], what);
}

/** 仓里有没有这个提交（换检出之前先看：已经有了就不用再从镜像取，取了反而是空包）。 */
export async function hasCommit(t: UserTree, sha: string): Promise<boolean> {
  assertSha(sha, '提交');
  const r = await run(t, [t.git ?? GIT, 'cat-file', '-e', `${sha}^{commit}`]);
  if (r.code === 0) return true;
  if (r.code === 1 || r.code === 128) return false;
  throw new PortError('GIT_FAILED', describeFailure('看仓里有没有这个提交', r), { retryable: true });
}

/** 把分支放到这个提交上并检出（新建的树用）。 */
export async function checkoutBranch(t: UserTree, branch: string, sha: string): Promise<void> {
  assertSha(sha, '检出的提交');
  await git(t, ['checkout', '-q', '-B', branch, sha], `检出 ${branch}`);
}

export async function headOf(t: UserTree): Promise<string> {
  return headOfRef(t, 'HEAD');
}

/** 树最后一次从引擎取进来的头（refs/fleet/incoming）：建树时的主线头，或并主线后的新头。引擎的镜像里一定有它，交 bundle 拿它当起点。 */
export async function headOfIncoming(t: UserTree): Promise<string> {
  return headOfRef(t, 'refs/fleet/incoming');
}

/**
 * 把 refs/fleet/incoming 钉到这个提交。并主线时工作树里还有没推的提交、在本地并上远端再推之后，下一回打 bundle 拿它当起点
 * （和快进那条路一样：快进完 incoming 就是新头）。提交必须已经在树里。
 */
export async function pinIncoming(t: UserTree, sha: string): Promise<void> {
  assertSha(sha, '取进来的头');
  if (!(await hasCommit(t, sha))) {
    throw new PortError('GIT_FAILED', `要把 refs/fleet/incoming 钉到 ${sha.slice(0, 7)}，树里没有这个提交`, {
      retryable: true,
    });
  }
  await git(t, ['update-ref', 'refs/fleet/incoming', sha], `把 incoming 钉到 ${sha.slice(0, 7)}`);
}

/**
 * base 之后到 head 的提交（不含 base、含 head），从旧到新。两边是同一个、或有一边不在这棵树里，回空列表，不抛。
 * 用来在并不上时说清哪几个没推的提交还在树上。
 */
export async function commitShasBetween(t: UserTree, base: string, head: string): Promise<string[]> {
  assertSha(base, '起点');
  assertSha(head, '头');
  if (base === head) return [];
  if (!(await hasCommit(t, base)) || !(await hasCommit(t, head))) return [];
  const listed = lines(await git(t, ['rev-list', '--reverse', `${base}..${head}`], '列这段提交'));
  return listed.filter((sha) => SHA.test(sha));
}

/**
 * 环境文件：开会话的钩子、引擎自己往树里写的设置，不是会话干的活（#2721：近 7 天 55 轮只因钩子改了 .claude/settings.json
 * 被判返工）。交活核对（deliveryLeftover）和每小时对账看树里还剩什么（treeLeftovers）用的都是这一份，不各写一份。
 * 改之前必须知道：只收真有人往树里写的（plugin-loader.mjs 改项目设置；segment-settings.ts 给 Mirasim 会话写挡子代理的
 * 设置，删了就挡不住），路径相对仓根、写全。.fleet-plugins.json 只有人放、没有钩子写，不收。
 */
export const ENVIRONMENT_FILES: readonly { path: string; why: string }[] = [
  {
    path: '.claude/settings.json',
    why: '项目设置：用户级开会话钩子 plugin-loader.mjs 按订阅改写过程钩子（Grok、Cursor、Mirasim 的会话不带 FLEET_HEADLESS）',
  },
  {
    path: '.claude/settings.local.json',
    why: '本地设置：引擎给 Mirasim 会话写的挡子代理设置（segment-settings.ts），仓里没忽略时显示成没跟踪的新文件',
  },
];

const ENVIRONMENT_PATHS: ReadonlySet<string> = new Set(ENVIRONMENT_FILES.map((f) => f.path));

/** git status --porcelain=v1 一行里的路径（改名、复制取新的那个）。 */
function porcelainPath(line: string): string {
  const path = line.slice(3);
  const arrow = path.indexOf(' -> ');
  return arrow >= 0 ? path.slice(arrow + 4) : path;
}

/**
 * 交活核对：工作树里没提交的改动（含新文件，不含忽略的；没跟踪的目录逐个文件列），环境文件不算。先还原：跟踪着的环境文件
 * 改了、删了，照 HEAD 拿回来（git checkout HEAD --），树真干净了，后面并主线、快进也不被它挡住；再剔除：没跟踪的环境文件
 * 不删（Mirasim 会话靠 .claude/settings.local.json 挡子代理），只从清单里拿掉。git 没跑成照抛，不当成干净。
 */
export async function deliveryLeftover(t: UserTree): Promise<string[]> {
  const paths = [...ENVIRONMENT_PATHS];
  const changed = lines(
    await git(t, ['diff', '--name-only', '--diff-filter=MDT', 'HEAD', '--', ...paths], '看环境文件改了没有'),
  );
  if (changed.length > 0) await git(t, ['checkout', 'HEAD', '--', ...changed], '还原环境文件');
  const status = lines(
    await git(t, ['status', '--porcelain=v1', '--untracked-files=all'], '看工作树里有没有没提交的改动'),
  );
  return status.filter((line) => !ENVIRONMENT_PATHS.has(porcelainPath(line)));
}

/** 没提交的已跟踪改动（交付判据：不许有）。 */
export async function uncommittedTracked(t: UserTree): Promise<string[]> {
  return lines(await git(t, ['status', '--porcelain', '--untracked-files=no'], '看有没有没提交的改动'));
}

/** `git diff --check` 报出的冲突标记文件。行尾空白之类别的告警不算。 */
function conflictMarkerFiles(check: UserCommandResult): string[] {
  const blob = `${text(check)}\n${check.stderr}`;
  const files: string[] = [];
  for (const line of blob.split('\n')) {
    const matched = /^(.*):\d+: leftover conflict marker$/.exec(line.trim());
    const file = matched?.[1];
    if (file) files.push(file);
  }
  return files;
}

/**
 * 这个文件在 HEAD 和钉住的主线上是不是同一个内容。主线原样带进来的（里面碰巧有一行七个等号）不算这次没解。
 * 查不成就抛，不当成「和主线一样」——那会把真没解的放过去。
 */
async function sameAsMainline(t: UserTree, mainline: string, file: string): Promise<boolean> {
  const r = await git(t, ['diff', '--quiet', mainline, 'HEAD', '--', file], `比 ${file} 和主线`, {
    allow: [1],
  });
  return r.code === 0;
}

/**
 * 树里还没解完的冲突。任一就算：MERGE_HEAD 还在；工作区或暂存区 `git diff --check` 看到冲突标记；
 * 或者这次提交进 HEAD 的文件里还有（`git diff --check <起点> HEAD`）。最后一种是会话没删标记、直接
 * `git add` 并提交：MERGE_HEAD 没了，工作区和暂存区的 diff 都是空的，标记却已经进了提交。
 * 起点用起会话前的头，不用 ownSpan 的 from：from 有时是带冲突标记的 merge-tree，再和 HEAD 比就看不出标记还在。
 * 和钉住的主线一个字节都不差的文件不算（主线自己带进来的）。没有就是空数组。查不成就抛，不当成没有。
 */
export async function unresolvedConflicts(
  t: UserTree,
  committed: { since: string; mainline: string },
): Promise<string[]> {
  assertSha(committed.since, '比冲突标记的起点');
  assertSha(committed.mainline, '主线');
  const left = await mergeLeft(t);
  if (left !== 'yes' && left !== 'no') {
    throw new PortError('GIT_FAILED', `有没有没并完的合并没查成（${left.unknown}）`, {
      retryable: true,
      details: { user: t.user, dir: t.dir },
    });
  }
  const files = new Set<string>();
  if (left === 'yes') {
    const listed = await git(t, ['diff', '--name-only', '--diff-filter=U'], '列没解的冲突');
    for (const file of lines(listed)) files.add(file);
  }
  for (const cached of [false, true]) {
    const check = await git(t, ['diff', ...(cached ? ['--cached'] : []), '--check'], '查冲突标记', {
      allow: [2],
    });
    if (check.code !== 2) continue;
    for (const file of conflictMarkerFiles(check)) files.add(file);
  }
  const committedCheck = await git(
    t,
    ['diff', '--check', committed.since, 'HEAD'],
    '查这次提交里的冲突标记',
    { allow: [2] },
  );
  if (committedCheck.code === 2) {
    for (const file of conflictMarkerFiles(committedCheck)) {
      if (await sameAsMainline(t, committed.mainline, file)) continue;
      files.add(file);
    }
  }
  // 标记删了并 git add、合并还没提交：未合并路径和 diff --check 都空了，文件名还在合并说明里。
  // 读不到说明才用占位，调用方再拿上一轮反馈里的文件名补挂起提醒。
  if (left === 'yes' && files.size === 0) {
    for (const file of await namesLeftInMerge(t)) files.add(file);
  }
  if (left === 'yes' && files.size === 0) files.add('（MERGE_HEAD 还在）');
  return [...files].sort();
}

/** 合并说明里 `Conflicts:` 下列的路径。git 每行是 `#` 加制表符再加路径；说明文字一来就停。 */
export function conflictFilesInMergeMessage(message: string): string[] {
  const files: string[] = [];
  let inList = false;
  for (const line of message.split('\n')) {
    if (!inList) {
      if (/^#\s*Conflicts:\s*$/.test(line)) inList = true;
      continue;
    }
    const matched = /^#\t(.*\S)\s*$/.exec(line);
    const file = matched?.[1];
    if (!file) break;
    files.push(file);
  }
  return files;
}

/** 以会话用户读树里的一个文件（相对路径）。不在回 null；读不了（权限、超时）抛 PortError，不当成不在。 */
export async function readTreeFile(t: UserTree, rel: string): Promise<Buffer | null> {
  const r = await run(t, [
    t.sh ?? SH,
    '-c',
    'if [ -e "$1" ]; then exec cat -- "$1"; else exit 3; fi',
    'sh',
    rel,
  ]);
  if (r.code === 3) return null;
  if (r.code !== 0) {
    throw new PortError('GIT_FAILED', describeFailure(`读树里的 ${rel}`, r), {
      retryable: !r.aborted,
      details: { user: t.user, dir: t.dir },
    });
  }
  return r.stdout;
}

/**
 * 以会话用户读他家目录里的一个文件（rel 相对家目录）；不在回 null，读不了抛 PortError。
 * 家目录按系统账号库（getent）查，不信环境里的 HOME（引擎起的一次性会话进程不一定带它）；home 只给测试用。
 */
export async function readHomeFile(t: UserTree, rel: string, home?: string): Promise<Buffer | null> {
  const r = await run(t, [
    t.sh ?? SH,
    '-c',
    'h=$2; if [ -z "$h" ]; then h=$(getent passwd "$(id -un)" | cut -d: -f6); fi; if [ -z "$h" ]; then exit 4; fi; f="$h/$1"; if [ -e "$f" ]; then exec cat -- "$f"; else exit 3; fi',
    'sh',
    rel,
    home ?? '',
  ]);
  if (r.code === 3) return null;
  if (r.code !== 0) {
    throw new PortError('GIT_FAILED', describeFailure(`读家目录里的 ${rel}`, r), {
      retryable: !r.aborted,
      details: { user: t.user },
    });
  }
  return r.stdout;
}

/** 以会话用户把字节写进树里的一个文件（相对路径，上级目录不在就建）。写不成抛 PortError。 */
export async function writeTreeFile(t: UserTree, rel: string, bytes: Buffer): Promise<void> {
  const r = await run(t, [t.sh ?? SH, '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', rel], {
    stdin: bytes,
  });
  if (r.code !== 0) {
    throw new PortError('GIT_FAILED', describeFailure(`写树里的 ${rel}`, r), {
      retryable: !r.aborted,
      details: { user: t.user, dir: t.dir },
    });
  }
}

/** MERGE_HEAD 还在、索引里已经没有未合并路径时，从合并说明把冲突文件名找回来。读不到就是空，不当成没有冲突。 */
async function namesLeftInMerge(t: UserTree): Promise<string[]> {
  const located = await run(t, [t.git ?? GIT, 'rev-parse', '--git-path', 'MERGE_MSG']);
  if (located.code !== 0) return [];
  const rel = text(located).trim();
  if (!rel) return [];
  const cat = await run(t, [t.sh ?? SH, '-c', 'exec cat -- "$1"', 'sh', rel]);
  if (cat.code !== 0) return [];
  return conflictFilesInMergeMessage(text(cat));
}

/**
 * 这一步（一个会话）自己改了什么，从哪儿比起。会话在树里并过主线（推之前并主线有冲突、退回会话照着 git merge 解；并好了
 * 却没推成、树停在引擎的并提交上），base..HEAD 就把并进来的主线也算成这一步改的：#293 的开 PR 前验证因此把主线上别人改的
 * 页面代码算成这张单改的，按界面类派，没人可派。所以一律先扣掉主线。主线 = 树里钉的 origin/<主线>（pinMainline：建树、
 * 推之前并主线、并主线后快进都跟着重钉）；HEAD 里含到的最新主线提交 = merge-base(主线, HEAD)：
 * - base 里已经有它（这一步没并进新主线）：从 base 比。
 * - base 是它的祖先（base 就在主线上，这一步把主线快进过来）：从它比。
 * - 都不是：从「base 并上它」比，即 git merge-tree 算出来的树（只写对象，不动工作树和引用）。主线带进来的在这棵树里和 HEAD
 *   一样，不算；解冲突改的（这棵树里是冲突标记）、并完又改的，都算这一步的。
 * 提交也一样：主线走得到的不算这一步的新提交（会话自己的并提交算）。
 */
export interface OwnSpan {
  /** 起会话前的头。 */
  base: string;
  /** 比改动的起点：base、HEAD 里含到的主线提交，或 merge-tree 算出来的树号。 */
  from: string;
  /** 树里钉的主线头：它走得到的提交不算这一步的。 */
  mainline: string;
}

/**
 * 算这一步从哪儿比起（见 OwnSpan）。树里没钉主线明确报 MAINLINE_MISSING：分不出哪些是并进来的主线，不拿 base 之后的全部
 * 冒充这一步改的（sessions.ts 起会话前给钉主线之前建的老树补钉）。
 */
export async function ownSpan(t: UserTree, base: string, defaultBranch: string): Promise<OwnSpan> {
  assertSha(base, '起点');
  const details = { user: t.user, dir: t.dir };
  const mainline = await pinnedMainline(t, defaultBranch);
  if (mainline === null) {
    throw new PortError(
      'MAINLINE_MISSING',
      `树里没有钉住的主线 origin/${defaultBranch}：分不出哪些改动是并进来的主线`,
      { retryable: false, details },
    );
  }
  // HEAD 里含到的最新主线提交；没有共同的祖先（git 退出 1）就是一个主线提交都没含
  const found = await git(t, ['merge-base', mainline, 'HEAD'], '找 HEAD 里含到的主线', { allow: [1] });
  const merged = found.code === 0 ? text(found).trim() : null;
  if (merged === null || (await isAncestor(t, merged, base))) return { base, from: base, mainline };
  if (await isAncestor(t, base, merged)) return { base, from: merged, mainline };
  // 退出 1 = 并出冲突：树照样写出来（冲突的文件里是冲突标记），会话解冲突改的就比得出来
  const what = `算 ${base.slice(0, 7)} 并上主线 ${merged.slice(0, 7)} 的样子`;
  const simulated = await git(t, ['merge-tree', '--write-tree', base, merged], what, { allow: [1] });
  const tree = text(simulated).split('\n', 1)[0]?.trim() ?? '';
  if (!SHA.test(tree)) {
    throw new PortError('GIT_FAILED', `${what}：输出认不出（${tree.slice(0, 80) || '空的'}）`, {
      retryable: true,
      details,
    });
  }
  return { base, from: tree, mainline };
}

/** 这一步改了哪些文件（并进来的主线不算，见 OwnSpan）。 */
export async function changedFilesSince(t: UserTree, span: OwnSpan): Promise<string[]> {
  assertSha(span.from, '比改动的起点');
  return lines(await git(t, ['diff', '--name-only', span.from, 'HEAD'], '列改动的文件'));
}

/** 这一步的新提交（老的在前，最多 limit 条；主线走得到的不算）。 */
export async function commitsSince(t: UserTree, span: OwnSpan, limit = 50): Promise<string[]> {
  assertSha(span.base, '起点');
  assertSha(span.mainline, '主线');
  return lines(
    await git(
      t,
      ['log', '--oneline', '--reverse', `-n${limit}`, 'HEAD', `^${span.base}`, `^${span.mainline}`],
      '列已提交的',
    ),
  );
}

/**
 * 分支相对主线的净改动（和 PR 在 GitHub 上显示的一样：git diff 主线...头，只看分叉点之后分支这边改的）。推之前刚把最新主线
 * 并进来，推上去的头就拿它算：开 PR 前验证判界面、给验证方的清单、PR 正文都按它，不按一轮轮累计的。
 */
export async function changedFilesAgainst(t: UserTree, mainline: string, head: string): Promise<string[]> {
  assertSha(mainline, '主线');
  assertSha(head, '头');
  return lines(await git(t, ['diff', '--name-only', `${mainline}...${head}`], '列分支相对主线改了哪些文件'));
}

/** 单个头最多列这么多个文件（和 db 的 PR_HEAD_FILES_MAX 一致）；超了只列前面的，调用方写日志。 */
export const NUMSTAT_MAX_FILES = 500;

/**
 * 分支相对主线改了哪些文件、各增删几行（git diff --numstat -z 主线...头，不识别改名：改名按「删一个加一个」算，路径才对得上）。
 * 任务页「已编辑 N 个文件 +x −y」读它（#3140）：一个头一次数全，不拿每次编辑的行数加。二进制文件 git 给 `-`，记 binary、没有行数。
 * 输出认不出照抛，不拿空顶。返回 total 是真实的文件数（可能比 files 多：只列前 NUMSTAT_MAX_FILES 个）。
 */
export async function numstatAgainst(
  t: UserTree,
  mainline: string,
  head: string,
): Promise<{
  files: { path: string; added: number | null; removed: number | null; binary: boolean }[];
  total: number;
}> {
  assertSha(mainline, '主线');
  assertSha(head, '头');
  const r = await git(
    t,
    ['diff', '--numstat', '-z', '--no-renames', `${mainline}...${head}`],
    '列分支相对主线每个文件增删的行',
  );
  const entries = text(r)
    .split('\0')
    .filter((e) => e !== '');
  const files: { path: string; added: number | null; removed: number | null; binary: boolean }[] = [];
  for (const entry of entries) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (!m) {
      throw new PortError('GIT_FAILED', `列每个文件增删的行：numstat 有一项认不出（${entry.slice(0, 80)}）`, {
        retryable: false,
      });
    }
    const binary = m[1] === '-' || m[2] === '-';
    files.push({
      path: m[3] as string,
      added: binary ? null : Number(m[1]),
      removed: binary ? null : Number(m[2]),
      binary,
    });
  }
  return { files: files.slice(0, NUMSTAT_MAX_FILES), total: files.length };
}

/**
 * 分支相对主线新增了多少行（git diff --numstat 主线...头 第一列相加，和 PR 在 GitHub 上的 additions 同口径；二进制文件记 0）。
 * 每日简报「流程健康」的重活 PR 新增行 p90 按它算（#2762）。输出认不出照抛，不拿 0 顶。
 */
export async function addedLinesAgainst(t: UserTree, mainline: string, head: string): Promise<number> {
  assertSha(mainline, '主线');
  assertSha(head, '头');
  const out = lines(
    await git(
      t,
      [
        '--no-replace-objects',
        'diff',
        '--numstat',
        '--no-ext-diff',
        '--no-textconv',
        `${mainline}...${head}`,
      ],
      '数分支相对主线新增的行',
    ),
  );
  let total = 0;
  for (const line of out) {
    const added = line.split('\t')[0] ?? '';
    if (added === '-') continue;
    if (!/^\d+$/.test(added)) {
      throw new PortError('GIT_FAILED', `数新增行：numstat 有一行认不出（${line.slice(0, 80)}）`, {
        retryable: false,
      });
    }
    total += Number(added);
  }
  return total;
}

/** head 在不在 base 之后（base 是 head 的祖先）。 */
export async function isAncestor(t: UserTree, base: string, head: string): Promise<boolean> {
  assertSha(base, '起点');
  assertSha(head, '头');
  const r = await git(t, ['merge-base', '--is-ancestor', base, head], '看提交先后', { allow: [1] });
  return r.code === 0;
}

/**
 * 把 base 之后到 head 的提交打成 bundle 交出来（git bundle create - 写到标准输出）。
 * 没有新提交 git 拒绝打空包：先看，没有就明确报 EMPTY_DELIVERY，不交空包。
 */
export async function bundleSince(t: UserTree, head: string, base: string): Promise<Buffer> {
  assertSha(head, '头');
  assertSha(base, '起点');
  const count = Number(text(await git(t, ['rev-list', '--count', `${base}..${head}`], '数新提交')).trim());
  if (!Number.isInteger(count))
    throw new PortError('GIT_FAILED', '数新提交：输出认不出', { retryable: true });
  if (count === 0) {
    throw new PortError('EMPTY_DELIVERY', `起会话前的头 ${base.slice(0, 7)} 之后没有新提交`, {
      retryable: false,
    });
  }
  // bundle 里只收引用：光给提交号 git 会当成空包拒掉。先把头挂到一个临时引用上，打完删掉。
  await git(t, ['update-ref', OUTGOING_REF, head], '挂临时引用');
  try {
    const r = await git(t, ['bundle', 'create', '-', OUTGOING_REF, `^${base}`], '打 bundle', {
      timeoutMs: 300_000,
    });
    if (r.stdout.length === 0)
      throw new PortError('GIT_FAILED', '打 bundle：输出是空的', { retryable: true });
    return r.stdout;
  } finally {
    await run(t, [t.git ?? GIT, 'update-ref', '-d', OUTGOING_REF]);
  }
}

/** 交出去的 bundle 里头挂的引用名（引擎导入时只认提交号，不认这个名字）。 */
export const OUTGOING_REF = 'refs/fleet/outgoing';

/**
 * 并主线之后把工作树快进到新头：新提交经 bundle 取进来，merge --ff-only。
 * 会话在本地又提交了、快进不了回 diverged（交给调用方判：会话还有没推的活）；已经是新头回 already。
 */
export async function fastForward(
  t: UserTree,
  bundle: Buffer,
  ref: string,
  newHead: string,
): Promise<'fast-forwarded' | 'already' | 'diverged'> {
  assertSha(newHead, '新头');
  const current = await headOf(t);
  if (current === newHead) return 'already';
  const fetched = await fetchBundle(t, bundle, ref);
  if (fetched !== newHead) {
    throw new PortError(
      'GIT_FAILED',
      `bundle 里的头 ${fetched.slice(0, 7)} 不是要快进到的 ${newHead.slice(0, 7)}`,
      {
        retryable: true,
      },
    );
  }
  return fastForwardToCommit(t, newHead);
}

/** 提交已经在树里（不用再取 bundle）：能快进就 merge --ff-only 过去；树在它之外还有提交回 diverged。 */
export async function fastForwardToCommit(
  t: UserTree,
  newHead: string,
): Promise<'fast-forwarded' | 'already' | 'diverged'> {
  assertSha(newHead, '新头');
  const current = await headOf(t);
  if (current === newHead) return 'already';
  if (!(await isAncestor(t, current, newHead))) return 'diverged';
  const dirty = await uncommittedTracked(t);
  if (dirty.length > 0) {
    throw new PortError(
      'WORKTREE_DIRTY',
      `工作树里有没提交的改动，快进不了：${dirty.slice(0, 5).join('；')}`,
      {
        retryable: false,
      },
    );
  }
  await git(t, ['merge', '--ff-only', '-q', newHead], '快进到新头');
  return 'fast-forwarded';
}

/** 推没成、主线又动过、再并一层：顺着第一个父提交最多认这么多层并提交（再多就不是「只是重推」了）。 */
const MAX_MERGE_CHAIN = 20;

/**
 * 头是不是「base 之后只有并提交的一串」：顺着第一个父提交往回走，每一步都得是并提交（两个父提交），直到走到 base。
 * 推之前并主线那一步做出来的就是这样；并完推没成、活动重试时主线又动过，会再并一层——连着几次都照样认它，接着推。
 * 中间夹着一个普通提交（会话交活之后树里又多了东西）就不认。
 */
export async function isMergeChainOnto(
  t: UserTree,
  head: string,
  base: string,
  maxDepth = MAX_MERGE_CHAIN,
): Promise<boolean> {
  assertSha(head, '头');
  assertSha(base, '起点');
  let cur = head;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parents = text(await git(t, ['rev-list', '--parents', '-n', '1', cur], '看父提交'))
      .trim()
      .split(/\s+/);
    if (parents.length !== 3) return false;
    const first = parents[1] as string;
    if (first === base) return true;
    cur = first;
  }
  return false;
}

/**
 * git 没跑成的白话，引它自己的错误行：以 error: / fatal: 开头的那几行（GIT_ENV 把语言钉成 C），没有再照 describeFailure
 * 引末尾几行。锁被占着时 git 先打一行「fatal: Unable to create '…/index.lock': File exists.」、后面跟五行劝人的话，
 * 只引末尾就把是哪把锁挡住的截掉了。
 */
function describeGitFailure(what: string, r: UserCommandResult): string {
  if (r.code === null) return describeFailure(what, r);
  const errors = r.stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(?:error|fatal):/.test(l));
  if (errors.length === 0) return describeFailure(what, r);
  return `${what}：退出码 ${r.code}（${errors.slice(0, 3).join(' / ')}）`;
}

/** 树里有没有没并完的合并（.git/MERGE_HEAD）。rev-parse -q --verify：有 0、没有 1，别的退出码是没查成。 */
async function mergeLeft(t: UserTree): Promise<'yes' | 'no' | { unknown: string }> {
  const r = await run(t, [t.git ?? GIT, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (r.code === 0) return 'yes';
  if (r.code === 1) return 'no';
  return { unknown: describeGitFailure('看 MERGE_HEAD', r) };
}

/** 撤销没成之后，树里留下了什么（报错里照实写）。 */
const MERGE_LEFT_TEXT =
  '树里还留着没并完的合并（.git/MERGE_HEAD 还在，工作树和暂存区可能停在并了一半的样子）';

/**
 * 把 sha（引擎取进来的最新主线头）并进当前分支（--no-ff，提交身份用树里设好的「干活的」机器人）。
 * 内容冲突（列出了没合并的文件，并且 MERGE_HEAD 还在）：不撤，冲突标记原样留在树里，回冲突的文件。
 * 调用方交回会话去解。撤掉的话会话起来看到的是干净的树，不知道冲突在哪（#1303）。
 * 没跟踪的文件挡着、钩子失败、列不出冲突：照旧撤掉（撤得掉的话），树回到并之前，不当成已经并好。
 * 没并成之后的收拾（列冲突、撤销）自己也可能没成：锁文件被占着时撤销会被同一把锁挡住。报错一律以「并」这一步开头，
 * 收拾哪步没成附在后面，树里留下了什么照实写。git 2.45 及以前写不了索引也会留下 MERGE_HEAD（退出码 1），2.46 起
 * 直接退出、不留（退出码 128）——哪种都照这个写法报，不靠 git 的版本。
 */
export async function mergeInto(
  t: UserTree,
  sha: string,
): Promise<{ merged: string } | { conflict: string[]; pending: boolean }> {
  assertSha(sha, '要并的提交');
  const bin = t.git ?? GIT;
  const what = `并 ${sha.slice(0, 7)}`;
  const details = { user: t.user, dir: t.dir };
  const r = await run(t, [bin, 'merge', '--no-ff', '--no-edit', '-q', sha], { timeoutMs: 300_000 });
  if (r.code === 0) return { merged: await headOf(t) };
  // 被叫停：后面的收拾也会立刻被叫停，不再跑
  if (r.aborted) throw new PortError('GIT_FAILED', describeFailure(what, r), { retryable: false, details });
  const after: string[] = [];
  let aborted = false;
  const listed = await run(t, [bin, '-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U']);
  const unmerged = listed.code === 0 ? lines(listed) : null;
  if (unmerged === null) {
    after.push(describeGitFailure('列冲突的文件', listed));
    aborted ||= listed.aborted;
  }
  const left = await mergeLeft(t);
  // 内容冲突留给会话：MERGE_HEAD 和冲突标记都还在，不再 git merge --abort。
  if (left === 'yes' && unmerged !== null && unmerged.length > 0) {
    return { conflict: unmerged, pending: true };
  }
  let undone = false;
  if (left === 'yes') {
    const abort = await run(t, [bin, 'merge', '--abort']);
    if (abort.code === 0) {
      undone = true;
    } else {
      after.push(describeGitFailure('撤掉没并成的合并', abort));
      aborted ||= abort.aborted;
      const still = await mergeLeft(t);
      if (still === 'yes') after.push(MERGE_LEFT_TEXT);
      else if (still === 'no')
        after.push('树里的 MERGE_HEAD 已经没了（撤销没报成功，工作树和暂存区什么样没再查）');
      else after.push(`树里还有没有没并完的合并没查成（${still.unknown}）`);
    }
  } else if (left !== 'no') {
    after.push(`有没有留下没并完的合并没查成（${left.unknown}），没撤`);
  }
  if (after.length > 0) {
    const head =
      unmerged !== null && unmerged.length > 0
        ? `${what}：有冲突（${unmerged.slice(0, 10).join('、')}）`
        : describeGitFailure(what, r);
    throw new PortError('GIT_FAILED', [head, ...after].join('；'), { retryable: !aborted, details });
  }
  // 索引里还有没合并的路径、但没有 MERGE_HEAD（合并没进入「正在合并」）：标记还在，同样留给会话。
  if (unmerged !== null && unmerged.length > 0) return { conflict: unmerged, pending: true };
  const stderr = r.stderr;
  if (/would be overwritten by merge/.test(stderr)) {
    const blocking = stderr
      .split('\n')
      .filter((l) => l.startsWith('\t'))
      .map((l) => l.trim())
      .filter(Boolean);
    // 合并没开始，树里没有冲突标记：会话得自己再并一次。
    return {
      conflict: blocking.length > 0 ? blocking : ['（工作树里有文件挡着，没列出是哪几个）'],
      pending: false,
    };
  }
  const message = `${describeGitFailure(what, r)}${undone ? '；没并成的合并已撤掉，树回到并之前' : ''}`;
  throw new PortError('GIT_FAILED', message, { retryable: true, details });
}

/** 一棵没有在跑的任务在用的树里还剩什么（每小时对账删树之前看，jobs/worktree-sweep.ts）。 */
export type TreeLeftovers =
  /** 这一层不是 git 仓，里面什么都没有（建树建到一半），或者只剩 DISPOSABLE 里的东西：删了不丢东西。 */
  | { kind: 'empty' }
  /**
   * 这一层不是 git 仓，里面有 DISPOSABLE 以外的文件：认不出是什么，不删。files 是排好序的前几个（相对这一层的路径），
   * 一共几个在 fileCount。
   */
  | { kind: 'not-repo'; files: string[]; fileCount: number }
  | {
      kind: 'repo';
      /**
       * 没提交的改动，前几行：跟踪着的文件改了、暂存了、删了（git status --porcelain 的行），没跟踪也没被忽略的新文件
       * 一个一个列（?? <路径>；DISPOSABLE 里的不算）。
       */
      dirty: string[];
      dirtyCount: number;
      /** 存着几个 stash。 */
      stashes: number;
      /** 没推的提交（前几个，一行一个），总数在 unpushedCount。 */
      unpushed: string[];
      unpushedCount: number;
    };

/** 报「树里还剩什么」时每样（文件、提交）最多列几个。 */
export const LEFTOVER_LIST_MAX = 10;

/**
 * 删了不丢东西的：能重新生成的编译和工具缓存，和引擎已经读走的结论文件。每小时对账看树里还剩什么时当成什么都不剩，
 * 只剩这些的树照空树删（jobs/worktree-sweep.ts）；git 仓里也一样。写法和 .gitignore 一样：/ 结尾的是目录（整个跳过、
 * 不往里走），别的是文件名（可带 *），名字在哪一层都算。只跳过 git 不跟踪的（仓外的、仓里没跟踪的），仓里跟踪着的文件
 * 改了照算：仓把它当源码提交了。
 * 改之前必须知道：名单以外的一律算剩着、交人拍；加一条要写明为什么删了不丢东西，只许单层名字（find、git 各认一遍）。
 */
export const DISPOSABLE: readonly { pattern: string; why: string }[] = [
  { pattern: '*.tsbuildinfo', why: 'TypeScript 增量编译的缓存：下次 tsc 编译时重新生成' },
  { pattern: 'node_modules/', why: '装好的依赖：pnpm install 按锁文件原样装回来' },
  { pattern: 'dist/', why: '编译产物：重新 build 就有' },
  { pattern: '.turbo/', why: 'Turborepo 的任务缓存：下次跑任务时重新生成' },
  { pattern: '.vite/', why: 'Vite、Vitest 的预构建和结果缓存：下次跑时重新生成' },
  { pattern: 'coverage/', why: '测试覆盖率报告：重跑测试就有' },
  {
    pattern: `${OUT_DIR}/`,
    why: '会话交给引擎的结论文件（分诊、需求文档、方案、审查、验证）：会话一结束引擎就读走了',
  },
];

/**
 * 名单里一条的名字：单层，字母数字和 . _ - *，不以 - 开头，至少有一个字母或数字（「*」「.」这种会把什么都跳过）。
 */
const DISPOSABLE_NAME = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._*][A-Za-z0-9._*-]*$/;

/**
 * 名单换成两种写法：git ls-files 的 --exclude（.gitignore 的写法原样给）；find 的表达式（名单里的目录剪掉不往里走、
 * 名单里的文件名跳过，剩下的非目录 \0 分隔打出来）。写法认不出照抛（BAD_INPUT），不当成名单是空的。
 */
export function disposableArgs(patterns: readonly string[]): { git: string[]; find: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const p of patterns) {
    const isDir = p.endsWith('/');
    const name = isDir ? p.slice(0, -1) : p;
    if (!DISPOSABLE_NAME.test(name)) {
      throw new PortError('BAD_INPUT', `不算剩着的名单里有认不出的写法（只许单层名字，/ 结尾是目录）：${p}`, {
        retryable: false,
      });
    }
    (isDir ? dirs : files).push(name);
  }
  const anyOf = (names: string[]) => names.flatMap((n, i) => [...(i > 0 ? ['-o'] : []), '-name', n]);
  return {
    git: patterns.map((p) => `--exclude=${p}`),
    find: [
      ...(dirs.length > 0 ? ['-type', 'd', '(', ...anyOf(dirs), ')', '-prune', '-o'] : []),
      ...(files.length > 0 ? ['(', ...anyOf(files), ')', '-o'] : []),
      '!',
      '-type',
      'd',
      '-print0',
    ],
  };
}

/**
 * git 碰上读不了的地方不退出：没跟踪的目录打不开只警告一句（warning: could not open directory '<目录>': Permission denied）、
 * 跟踪着的文件看不了只打一行（<路径>: Permission denied），照样退出 0，把那里当成什么都没有。GIT_ENV 把语言钉成 C，
 * 认得出这两种。
 */
const UNREADABLE = /: (?:Permission denied|Operation not permitted)$/;

/** 跑一条看工作树的 git：没跑成照 git() 抛；跑成了、却有读不了的地方，抛 READ_FAILED（没查成，不当成那里什么都没有）。 */
async function gitReading(t: UserTree, args: string[], what: string): Promise<UserCommandResult> {
  const r = await git(t, args, what);
  const unreadable = r.stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => UNREADABLE.test(l));
  if (unreadable.length > 0) {
    throw new PortError('READ_FAILED', `${what}：有读不了的地方（${unreadable.slice(0, 3).join(' / ')}）`, {
      retryable: true,
      details: { user: t.user, dir: t.dir },
    });
  }
  return r;
}

/**
 * 以会话用户的身份量这棵树多大（字节，du -sk，按占用的块算、硬链接只算一次）：资源页「每个仓占多少」用（#1993）。
 * 只读，在跑的树也能量。du 没跑成、有读不了的地方、输出认不出都抛（没量成），不当成 0。
 */
export async function treeBytes(t: UserTree): Promise<number> {
  const r = await run(t, ['/usr/bin/du', '-sk', '--', t.dir], { timeoutMs: 60_000 });
  if (r.code !== 0) {
    throw new PortError('READ_FAILED', describeFailure('量这棵树多大（du）', r), { retryable: true });
  }
  const m = /^(\d+)\s/.exec(text(r));
  if (!m?.[1])
    throw new PortError('READ_FAILED', `du 的输出认不出：${text(r).slice(0, 80)}`, { retryable: false });
  return Number(m[1]) * 1024;
}

/** \0 分隔的输出（-z、-print0）：一段一个，空的不要。 */
const nulSeparated = (r: UserCommandResult) => r.stdout.toString('utf8').split('\0').filter(Boolean);

/** 检出副本往回看多少条检出记录（HEAD 的 reflog）：一个副本一轮一次检出，够用；更早的只会多算。 */
const CHECKOUT_LOG_MAX = 200;

export interface LeftoverOptions {
  /** 调用方刚按 blob 核实仍与已交付/已归档图片一致的精确路径；不忽略整个目录。 */
  preservedPaths?: readonly string[];
  /**
   * 引擎的检出副本（分诊、需求文档、方案、审查、开 PR 前验证：sessions.ts 每起一个新会话都 checkout --force + clean -fdx
   * 从头来）：它在这里检出过的提交（HEAD 的检出记录）都是从引擎的镜像取的，算推过。写码的树不给：那里的检出记录
   * 可能是会话自己切的。
   */
  scratch?: boolean;
}

/**
 * 以会话用户的身份看这棵树里还有什么没推、没提交的。known = 推上去过的头（PR 镜像里这条分支的头）；树自己的
 * refs/fleet/incoming（引擎交给它的主线头或 PR 头）和 refs/remotes/*（钉的主线）也算推过的。没推的提交 = HEAD、本地分支、
 * 标签走得到，上面这些都走不到的提交；给的头树里没有就跳过（--ignore-missing）：只会多算、不会少算，多算的交人拍。
 * 还没有提交的仓（建树时 init 之后取包没成）只看分支和标签。DISPOSABLE 里的不算剩着。git 没跑成、有读不了的目录，
 * 一律抛 PortError，不拿空结果冒充「什么都没剩」。
 */
export async function treeLeftovers(
  t: UserTree,
  known: readonly string[],
  options: LeftoverOptions = {},
): Promise<TreeLeftovers> {
  for (const sha of known) assertSha(sha, '推上去过的头');
  const skip = disposableArgs(DISPOSABLE.map((d) => d.pattern));
  const bin = t.git ?? GIT;
  // 这一层是不是仓的顶：--show-prefix 在顶上打空行，在子目录里打相对路径；不是仓（往上也找不到）退出 128
  const top = await run(t, [bin, 'rev-parse', '--show-prefix']);
  if (top.code !== 0 && top.code !== 128) {
    throw new PortError('GIT_FAILED', describeFailure('看这一层是不是 git 仓', top), { retryable: true });
  }
  if (top.code === 128 || text(top).trim() !== '') {
    // 不是仓：一层层往下列，剩下的非目录（文件、链接……）都算，空目录不算（git 也不认空目录）。find 碰上读不了的目录
    // 照样往下列、最后退出非 0：没查成，不当成那里什么都没有
    const listed = await run(t, [t.sh ?? SH, '-c', 'exec find . -mindepth 1 "$@"', 'sh', ...skip.find]);
    if (listed.code !== 0) {
      throw new PortError('READ_FAILED', describeFailure('列树里的东西', listed), { retryable: true });
    }
    const files = nulSeparated(listed)
      .map((p) => p.replace(/^\.\//, ''))
      .sort();
    return files.length === 0
      ? { kind: 'empty' }
      : { kind: 'not-repo', files: files.slice(0, LEFTOVER_LIST_MAX), fileCount: files.length };
  }
  // 有没有检出过提交：退出 1 = 还没有（HEAD 指着一个还没生出来的分支），别的非 0 是 git 没跑成
  const born = await run(t, [bin, 'rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  if (born.code !== 0 && born.code !== 1) {
    throw new PortError('GIT_FAILED', describeFailure('看树里检出过提交没有', born), { retryable: true });
  }
  const hasHead = born.code === 0;
  // 跟踪着的文件的改动一律算；没跟踪的新文件另列（名单里的跳过、不往里走），一个一个列，没跟踪的目录不折成一行
  const changed = await gitReading(
    t,
    ['status', '--porcelain=v1', '--untracked-files=no'],
    '看有没有没提交的改动',
  );
  const untracked = await gitReading(
    t,
    ['ls-files', '-z', '--others', '--exclude-standard', ...skip.git],
    '列没跟踪的新文件',
  );
  // 环境文件（ENVIRONMENT_FILES：钩子、引擎写的设置）不算剩着，和交活核对同一份名单
  const dirty = [
    ...lines(changed).filter((line) => !ENVIRONMENT_PATHS.has(porcelainPath(line))),
    ...nulSeparated(untracked)
      .filter((f) => !ENVIRONMENT_PATHS.has(f) && !options.preservedPaths?.includes(f))
      .map((f) => `?? ${f}`),
  ];
  const stashes = lines(await git(t, ['stash', 'list'], '看有没有存着的 stash')).length;
  const checkouts =
    options.scratch && hasHead
      ? lines(
          await git(
            t,
            ['reflog', 'show', '--format=%H %gs', `-n${CHECKOUT_LOG_MAX}`, 'HEAD', '--'],
            '读检出记录',
          ),
        ).flatMap((l) => {
          const [sha, ...subject] = l.split(' ');
          return sha && SHA.test(sha) && subject.join(' ').startsWith('checkout: moving from ') ? [sha] : [];
        })
      : [];
  const range = [
    ...(hasHead ? ['HEAD'] : []),
    '--branches',
    '--tags',
    '--not',
    '--remotes',
    'refs/fleet/incoming',
    ...known,
    ...new Set(checkouts),
  ];
  const count = Number(
    text(await git(t, ['rev-list', '--count', '--ignore-missing', ...range], '数没推的提交')).trim(),
  );
  if (!Number.isInteger(count) || count < 0) {
    throw new PortError('GIT_FAILED', '数没推的提交：输出认不出', { retryable: true });
  }
  const unpushed =
    count === 0
      ? []
      : lines(
          await git(
            t,
            ['log', '--oneline', '--ignore-missing', `-n${LEFTOVER_LIST_MAX}`, ...range],
            '列没推的提交',
          ),
        );
  return {
    kind: 'repo',
    dirty: dirty.slice(0, LEFTOVER_LIST_MAX),
    dirtyCount: dirty.length,
    stashes,
    unpushed,
    unpushedCount: count,
  };
}

/** 自包含成果包：不排除基线，包含 detached HEAD 与所有引用；包过大或读取失败就留原树。 */
export async function recoveryBundle(t: UserTree): Promise<Buffer> {
  const r = await git(t, ['bundle', 'create', '-', '--all', 'HEAD'], '打完整成果包', {
    timeoutMs: 240_000,
  });
  if (r.stdout.length === 0) throw new PortError('READ_FAILED', '完整成果包是空的，保留原树');
  return r.stdout;
}

/** 用来核对打包期间有没有换头/换引用，以及空仓恢复后是否完整。 */
export async function recoveryIdentity(t: UserTree): Promise<string> {
  const head = await headOf(t);
  const tree = text(await git(t, ['rev-parse', 'HEAD^{tree}'], '读成果内容树')).trim();
  assertSha(tree, '成果内容树');
  const refs = text(await git(t, ['for-each-ref', '--format=%(objectname) %(refname)'], '读成果引用'));
  return `${head}\n${tree}\n${refs}`;
}

/** 落盘回读的包在会话用户的临时空仓独立恢复，不借原仓的对象、alternates 或基线。 */
export async function verifyRecoveryBundle(t: UserTree, bytes: Buffer, identity: string): Promise<void> {
  const script = [
    'set -eu',
    'umask 077',
    'd=$(mktemp -d -t fleet-recovery.XXXXXXXX)',
    'd=$(cd "$d" && pwd -P)',
    'case "$d" in */fleet-recovery.????????) ;; *) echo "unexpected recovery directory" >&2; exit 1;; esac',
    'trap \'rm -rf -- "$d"\' EXIT',
    'cat > "$d/recovery.bundle"',
    '"$1" -c init.templateDir= init --bare -q "$d/repo"',
    '"$1" -C "$d/repo" bundle verify "$d/recovery.bundle" >&2',
    '"$1" -C "$d/repo" -c maintenance.auto=false -c gc.auto=0 fetch --no-tags -q "$d/recovery.bundle" "+refs/*:refs/*" HEAD',
    'head=$("$1" bundle list-heads "$d/recovery.bundle" HEAD | cut -d " " -f1)',
    '"$1" -C "$d/repo" update-ref --no-deref HEAD "$head"',
    '"$1" -C "$d/repo" fsck --full --no-progress >&2',
    '"$1" -C "$d/repo" rev-parse HEAD "HEAD^{tree}"',
    '"$1" -C "$d/repo" for-each-ref "--format=%(objectname) %(refname)"',
  ].join('\n');
  const r = await run(t, [t.sh ?? SH, '-c', script, 'sh', t.git ?? GIT], {
    stdin: bytes,
    timeoutMs: 240_000,
  });
  if (r.code !== 0 || text(r).replace(/\r\n/g, '\n') !== identity.replace(/\r\n/g, '\n')) {
    throw new PortError(
      'ARCHIVE_FAILED',
      `空仓恢复成果包未核对成功，保留原树：${describeFailure('恢复核验', r)}`,
      {
        details: { dir: t.dir },
      },
    );
  }
}
