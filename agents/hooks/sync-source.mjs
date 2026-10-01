// 同步用的「专用检出」（用在哪：agents/hooks/session-start.mjs 的开会话钩子、packages/agents-sync/src/sync-now.ts 的
// pnpm agents:sync）：这台机器上永远只拿 origin/main 上的东西去同步，和开发机自己的 fleet-dao 检出现在在哪个分支、
// 有没有没提交的改动无关。
//
// 为什么要有它：开会话钩子原来是在开发机自己的检出里 fetch + 快进 main 再同步，于是主检出只要被人（AI 自己就常这样）
// 切到功能分支上干活，这台机器就一直停在旧规矩上，没人提醒不会好（2026-10-01 创始人：「我希望每台机器，能在我们改动后，
// 自动就同步，而不是人为提醒」）。现在另立一份检出，它只归本工具，永远停在 origin/main 的分离头上；本机自己的检出
// 只被当「种子」读（它的 origin 地址、它的本地对象），一个写操作都没有。
//
// 规矩（改这里之前必须知道）：
// - 只认 origin/main：从不拿功能分支、也不拿本地没推的改动去同步。取不到远端就明说没查成，不拿旧的冒充最新。
// - 专用检出里出现没提交的改动（人改的、上次 checkout 写到一半留下的）就整份挪到它旁边的 `<dir>.bak-<时间>`（不删），
//   再从零建一个干净的换上去：这条路上永远不拿仓库里没推的内容去同步，也不丢东西。
// - 建的时候显式写死 core.autocrlf=false：专用检出里读到的字节要和仓里存的字节一致。开着 autocrlf 时 checkout 会把
//   文件换成 CRLF（本机 gitconfig 就是 true），读回来的内容就和仓里的 blob 不是一回事了（2026-10-01 实测）。
// - 这台机器的 git 跑不起来、取不到远端、checkout 没落到 origin/main 上，都是要明说的失败，不当成「已是最新」。
// - 测试：packages/agents-sync/test/sync-source.test.ts（真 git、临时目录）；这条路上每处失败都配一条故意造出来的。
//
// 只导出函数和常量，import 的时候不干活：装着它的开会话钩子（~/.fleet-dao/hooks/session-start.mjs）也 import 它。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 专用检出放哪：~/.fleet-dao/origin-main（Windows、Linux 一样） */
export const SYNC_DIR = join('.fleet-dao', 'origin-main');
/** 一次同步全程拿的锁：几个会话同时开，别两个一起 fetch、一起切 */
export const LOCK_FILE = join('.fleet-dao', 'origin-main.lock');
/** 拿锁的进程已经不在了，或者锁放了这么久，当成上次崩了留下的 */
export const LOCK_STALE_MS = 10 * 60_000;
export const READ_MS = 15_000;
export const FETCH_MS = 60_000;

const ORIGIN_MAIN = 'refs/remotes/origin/main';
/** 只跟 main、不跟标签：这条路上只用得到 main，别把远端的别的分支和标签都搬回来 */
const MAIN_ONLY = `+refs/heads/main:${ORIGIN_MAIN}`;

const short = (sha) => String(sha ?? '').slice(0, 7);

export function syncDirIn(home) {
  return join(home, SYNC_DIR);
}

export function lockFileIn(home) {
  return join(home, LOCK_FILE);
}

/** git 跑一条命令：{ status, stdout, stderr, error, timeoutMs }。dir 是个目录，git -C 进去跑。 */
export function gitRunner(timeoutMs = READ_MS) {
  return (dir, args, opts = {}) => {
    const timeout = opts.timeoutMs ?? timeoutMs;
    const r = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      error: r.error,
      timeoutMs: timeout,
    };
  };
}

const ranOk = (r) => r.status === 0 && !r.error;
/**
 * git 自己没跑起来：起不来、超时、没有退出码，或者 Windows 上程序没起来给的那类大退出码（0xC0000xxx）。
 * 和「git 说这里不是仓、没有 origin、没这个 ref」分开：那些 git 是说了话的（0、128 之类的退出码）。
 */
const broke = (r) =>
  r.error !== undefined ||
  typeof r.status !== 'number' ||
  (r.status !== 0 && r.status !== 128 && r.status > 0x7fffffff);

/**
 * 一条 git 为什么没成：超时、起不来、git 说的第一句，或者 Windows 上程序没起来给的大退出码。
 * （0xC0000135 = 缺 DLL；本机 2026-09-30 撞过，光写十进制看不出来。）
 */
export function why(r) {
  if (r.error) {
    return r.error.code === 'ETIMEDOUT'
      ? `超过 ${Math.round((r.timeoutMs ?? READ_MS) / 1000)} 秒没完`
      : `起不来：${r.error.message}`;
  }
  const line = `${r.stderr ?? ''}\n${r.stdout ?? ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (line) return line;
  if (typeof r.status === 'number' && r.status > 0x7fffffff)
    return `退出码 ${r.status}（0x${r.status.toString(16).toUpperCase()}，Windows 上程序没起来，多半缺 DLL）`;
  return `退出码 ${r.status}`;
}

/** 两个路径说的是不是同一处（Windows 上不认大小写） */
export function samePath(a, b) {
  const n = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return n(a) === n(b);
}

function realOrSelf(p) {
  try {
    return resolve(realpathSync.native(p));
  } catch {
    return resolve(p);
  }
}

/** 是不是一个能用的专用检出：是仓、仓根就是它自己、origin 指向哪读得到 */
function inspect(dir, g) {
  const inside = g(dir, ['rev-parse', '--is-inside-work-tree']);
  if (broke(inside)) return { kind: 'broken', why: `git 跑不起来（${why(inside)}）` };
  if (!ranOk(inside) || inside.stdout.trim() !== 'true') return { kind: 'broken', why: '里面不是 git 检出' };
  const top = g(dir, ['rev-parse', '--show-toplevel']);
  if (!ranOk(top)) return { kind: 'broken', why: `读不出仓根（${why(top)}）` };
  if (!samePath(realOrSelf(top.stdout.trim()), realOrSelf(dir)))
    return { kind: 'broken', why: `它的仓根是 ${top.stdout.trim()}，不是它自己` };
  const url = g(dir, ['config', '--get', 'remote.origin.url']);
  if (ranOk(url) && url.stdout.trim() !== '') return { kind: 'ok', url: url.stdout.trim() };
  return { kind: 'broken', why: '没有 origin（不知道从哪取）' };
}

/** 种子（开发机自己的检出，或者旧记录里记的那个）：只读它，拿它的 origin 地址 */
function seedUrlOf(seed, g) {
  if (typeof seed !== 'string' || seed === '' || !existsSync(seed)) return null;
  const inside = g(seed, ['rev-parse', '--is-inside-work-tree']);
  if (!ranOk(inside) || inside.stdout.trim() !== 'true') return null;
  const url = g(seed, ['config', '--get', 'remote.origin.url']);
  return ranOk(url) && url.stdout.trim() !== '' ? url.stdout.trim() : null;
}

/** 有没提交的改动（含没进 .gitignore 的新文件）。读不出来就返回为什么，不当成「干净」 */
function dirtOf(dir, g) {
  const st = g(dir, ['status', '--porcelain']);
  if (!ranOk(st)) return { ok: false, why: why(st) };
  const lines = st.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  return { ok: true, clean: lines.length === 0, sample: lines.slice(0, 5).map((l) => l.trim()) };
}

const headOf = (dir, g) => {
  const r = g(dir, ['rev-parse', 'HEAD']);
  return ranOk(r) ? r.stdout.trim() : null;
};

const originMainOf = (dir, g) => {
  const r = g(dir, ['rev-parse', '-q', '--verify', `${ORIGIN_MAIN}^{commit}`]);
  return ranOk(r) ? r.stdout.trim() : null;
};

/**
 * 建 / 重建专用检出：init（写死 autocrlf=false）、设 origin、先从本地那份取、再取远端、分离头切到 origin/main，
 * 读回对不上就算失败。
 * localFrom 是本地的一份检出（种子，或者被挪走的旧专用检出），只用来省下载，不是权威来源；本机上的
 * refs/remotes/origin/main 不在 fetch 的来源里（fetch 只认 heads/tags），所以先把它写成新仓的 FETCH_HEAD 那一格。
 */
function buildSyncDir(dir, url, localFrom, want, options, g) {
  /** 本机能读到的 origin/main：本地那份优先，其次种子 */
  const knownLocal = () => {
    for (const from of [localFrom, options.seed]) {
      if (typeof from !== 'string' || from === '' || !existsSync(from)) continue;
      const at = originMainOf(from, g);
      if (at !== null) return at;
    }
    return null;
  };
  try {
    mkdirSync(dirname(dir), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  } catch (err) {
    return `建不了 ${dir}（${err?.code ?? err?.message ?? err}）`;
  }
  const init = g(dir, ['init', '-q']);
  if (!ranOk(init)) return `在 ${dir} 里 git init 没成（${why(init)}）`;
  // 读到的字节要和仓里存的一致：本机 gitconfig 的 autocrlf=true 会把 checkout 出来的文件换成 CRLF（2026-10-01 实测）
  const cfg = g(dir, ['config', 'core.autocrlf', 'false']);
  if (!ranOk(cfg)) return `设不了 core.autocrlf（${why(cfg)}）`;
  const add = g(dir, ['remote', 'add', 'origin', url]);
  if (!ranOk(add)) return `设不了 origin（${why(add)}）`;

  // 本地那份要是真检出才有得取；它在本机上，快、也不出网。取到多少算多少：取不回来就跳过，下面照旧取远端
  const usableLocal =
    typeof localFrom === 'string' &&
    localFrom !== '' &&
    existsSync(localFrom) &&
    ranOk(g(localFrom, ['rev-parse', '--is-inside-work-tree']));
  if (usableLocal) {
    // 不带 refspec 取：本地那份可能只有 refs/remotes/origin/main（专用检出的分离头就是这样），
    // 按名字要 refs/heads/main 会直接说没有；不带 refspec 是把它的 HEAD 和它能给的对象拿过来
    const local = g(dir, ['fetch', '-q', '--no-tags', localFrom], { timeoutMs: options.fetchMs });
    if (!ranOk(local)) return `从 ${localFrom} 取对象没成（${why(local)}）`;
  }
  if (options.offline) {
    // 不取远端时得自己把 origin/main 记上：本地那份的 refs/remotes/origin/main 不在 fetch 的来源里
    const known = knownLocal();
    if (known === null)
      return '不取远端时本地得先有 origin/main，现在没有：先跑一遍联网的同步（不带 --offline）';
    const put = g(dir, ['update-ref', ORIGIN_MAIN, known]);
    if (!ranOk(put)) return `把本机的 origin/main（${short(known)}）记进新检出没成（${why(put)}）`;
  } else {
    const net = g(dir, ['fetch', '-q', '--no-tags', 'origin', MAIN_ONLY], { timeoutMs: options.fetchMs });
    if (!ranOk(net))
      return `取远端失败（${why(net)}）；网络不通时加 --offline，按本机现有（上次取到）的主线同步`;
  }
  const at = originMainOf(dir, g);
  if (at === null) return `${dir} 里没有 origin/main`;
  if (typeof want === 'string' && want !== '' && at !== want)
    return `${dir} 里的 origin/main 是 ${short(at)}，和本机读到的 ${short(want)} 对不上`;
  const checkout = g(dir, ['checkout', '-q', '--detach', at]);
  if (!ranOk(checkout)) return `切到 ${short(at)} 没成（${why(checkout)}）`;
  const head = headOf(dir, g);
  if (head !== at) return `切完是 ${short(head)}，不是 origin/main 的 ${short(at)}`;
  const dirt = dirtOf(dir, g);
  if (!dirt.ok) return `读不出刚建好的 ${dir} 的状态（${dirt.why}）`;
  if (!dirt.clean) return `刚建好的 ${dir} 里有改动（${dirt.sample.join('；')}）`;
  return null;
}

/** 把旧的整份挪到旁边（不删），再把位置腾出来 */
function aside(dir) {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  let dest = `${dir}.bak-${stamp}`;
  for (let n = 1; existsSync(dest); n++) dest = `${dir}.bak-${stamp}.${n}`;
  try {
    renameSync(dir, dest);
    return { ok: true, dest };
  } catch (err) {
    return { ok: false, why: `${err?.code ?? err?.message ?? err}` };
  }
}

/**
 * 把专用检出准备好：它这下总是停在 origin/main 的分离头上、工作区干净。返回 dir 就是要同步的那个检出。
 * 开发机自己的检出一个字都不动（只读它的 origin 地址和本地对象）。
 * 选项：
 *   seed     用来建的种子（开发机自己的检出）；没有、专用检出又不在时只能报失败
 *   check    只读：不 fetch、不快进、不建、不修（pnpm agents:sync --check 用）
 *   offline  不取远端，按本机上次取到的 origin/main 走
 *   repair   专用检出脏了、坏了时，允不允许整份挪到旁边再从零建一个（--apply 允许，--check 不允许）
 */
export function prepareSource(home, seed, options = {}) {
  const deps = options.deps ?? {};
  // 换 git 有两种给法：直接给一个 git(dir, args)（钩子那边就这么用），或者给一个工厂（带上宽一点的超时）
  const g = deps.git ?? (deps.gitFactory ?? gitRunner)();
  const fetchMs = deps.fetchMs ?? FETCH_MS;
  const dir = syncDirIn(home);
  const opts = { fetchMs, offline: options.offline === true, seed };
  const fail = (why) => ({ ok: false, dir, why });
  const unchecked = (why) => ({ ok: false, dir, why, unchecked: true });
  const done = (url, head, extra = {}) => ({ ok: true, dir, url, head, repaired: false, ...extra });

  // 这台的 git 能不能起来，先问一句：起不来时说清是 git 起不来（缺 DLL、PATH 上没有），别说成「里面不是 git 检出」。
  // 换过 git（测试塞的假 git）时跳过：那个假 git 多半只认这里真正要跑的那几条。
  if (deps.git === undefined && deps.gitFactory === undefined) {
    const alive = g(dir, ['rev-parse', '--is-inside-work-tree']);
    if (broke(alive)) return fail(`这台的 git 跑不起来（${why(alive)}），没法核对 ${dir}`);
  }

  if (options.check === true) {
    if (!existsSync(dir))
      return fail(`同步专用的检出 ${dir} 还没建过：先在这台机器上跑一遍 pnpm agents:sync`);
    const info = inspect(dir, g);
    if (info.kind !== 'ok') return fail(`${dir} ${info.why}`);
    const dirt = dirtOf(dir, g);
    if (!dirt.ok) return fail(`读不出 ${dir} 的状态（${dirt.why}）`);
    if (!dirt.clean) return unchecked(`${dir} 里有没提交的改动（${dirt.sample.join('；')}）`);
    return done(info.url, headOf(dir, g) ?? '');
  }

  if (!existsSync(dir)) {
    // 第一次：拿种子（记录里记的那个检出，或者跑这条命令的这个检出）把专用检建立起来
    const url = seedUrlOf(seed, g);
    if (url === null)
      return fail(
        `这台还没建同步专用的检出（${dir}），也没有能当种子的 fleet-dao 检出；` +
          (opts.offline
            ? '先跑一遍联网的同步（不带 --offline）把专用检建立起来'
            : '在任一 fleet-dao 检出里跑一遍 pnpm agents:sync'),
      );
    const built = buildSyncDir(dir, url, seed, null, opts, g);
    if (built !== null) return fail(built);
    return done(url, headOf(dir, g) ?? '', { repaired: true, fresh: true });
  }

  const info = inspect(dir, g);
  if (info.kind !== 'ok') {
    // 坏了：先从种子、再从它自己记的 origin 找地址；重建时拿它现存的本地对象当来源
    const url = seedUrlOf(seed, g) ?? seedUrlOf(dir, g);
    if (url === null) return fail(`${dir} ${info.why}，也找不到当初是从哪取的`);
    const keep = originMainOf(dir, g);
    if (options.repair !== true)
      return unchecked(`${dir} ${info.why}；--check 不建不修，跑 pnpm agents:sync 修`);
    const moved = aside(dir);
    if (!moved.ok) return fail(`${dir} ${info.why}，也挪不动它（${moved.why}）`);
    const built = buildSyncDir(dir, url, moved.dest, keep, opts, g);
    if (built !== null) return fail(`${built}（原来那份挪到了 ${moved.dest}）`);
    return done(url, headOf(dir, g) ?? '', { repaired: true });
  }
  const url = info.url;

  if (!opts.offline) {
    const net = g(dir, ['fetch', '-q', '--no-tags', 'origin', MAIN_ONLY], { timeoutMs: fetchMs });
    if (!ranOk(net))
      return fail(`取远端失败（${why(net)}）；网络不通时加 --offline，按本机上次取到的主线同步`);
  }
  const want = originMainOf(dir, g);
  if (want === null) return fail(`${dir} 里没有 origin/main`);

  const dirt = dirtOf(dir, g);
  if (!dirt.ok) return unchecked(`读不出 ${dir} 的状态（${dirt.why}）`);
  if (!dirt.clean) {
    if (options.repair !== true) return unchecked(`${dir} 里有没提交的改动（${dirt.sample.join('；')}）`);
    const moved = aside(dir);
    if (!moved.ok) return fail(`${dir} 里有没提交的改动，也挪不动它（${moved.why}）；看一眼那是哪来的`);
    const built = buildSyncDir(dir, url, moved.dest, want, opts, g);
    if (built !== null) return fail(`${built}（原来那份挪到了 ${moved.dest}）`);
    return done(url, headOf(dir, g) ?? '', { repaired: true, dirt: dirt.sample });
  }

  const head = headOf(dir, g);
  if (head === want) return done(url, head);
  const checkout = g(dir, ['checkout', '-q', '--detach', want]);
  if (!ranOk(checkout)) return fail(`在 ${dir} 切到 ${short(want)} 没成（${why(checkout)}）`);
  const after = headOf(dir, g);
  if (after !== want) return fail(`切完是 ${short(after)}，不是 origin/main 的 ${short(want)}`);
  return done(url, after, { moved: true });
}

/**
 * 一次同步全程拿的锁：几个会话同时开，别两个一起 fetch、一起切。
 * 拿不到时说清是谁拿着（进程号、多久前拿的），这次什么都不动。
 */
export function takeSourceLock(home, deps = {}) {
  const file = lockFileIn(home);
  const now = deps.now ?? Date.now();
  const pid = deps.pid ?? process.pid;
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    // 建不出来，下面的写会说
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${pid} ${new Date(now).toISOString()}\n`, { flag: 'wx' });
      return {
        ok: true,
        release: () => {
          try {
            unlinkSync(file);
          } catch {
            // 已经不在了
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST')
        return { ok: false, why: `拿不到锁（${err?.code ?? err?.message ?? err}）` };
    }
    let holder = NaN;
    let age = 0;
    try {
      holder = Number(readFileSync(file, 'utf8').split(' ')[0]);
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (attempt === 0 && (dead(holder) || age > LOCK_STALE_MS)) {
      try {
        unlinkSync(file);
      } catch {
        // 别人先清掉了
      }
      continue;
    }
    return {
      ok: false,
      why: `另一个同步正在做（进程 ${Number.isNaN(holder) ? '认不出' : holder}，${Math.max(0, Math.round(age / 1000))} 秒前拿的锁）`,
    };
  }
  return { ok: false, why: '拿不到锁（它一直被人占着）' };
}

/** 拿锁的那个进程还在不在：发个 0 号信号；没权限发也说明它在 */
function dead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code !== 'EPERM';
  }
}
