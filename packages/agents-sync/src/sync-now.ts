// 一键同步（pnpm agents:sync）：把这台机器的规矩、技能、钩子、权限同步到 origin/main 上的内容，逐项结果原样打出来。
// 开会话钩子（agents/hooks/session-start.mjs）每次开会话自动做同样的事；这条是「现在就要、看得见」的手动入口。
//
// 同步用的检出固定在 ~/.fleet-dao/origin-main（agents/hooks/sync-source.mjs）：它只归本工具，永远停在 origin/main 的
// 分离头上。这台机器自己的 fleet-dao 检出在哪个分支、有没有没提交的改动，都不影响同步；那边的检出只被当「种子」读
// （拿它的 origin 地址、本地对象），一个写操作都没有。原来「不拿别的分支同步」这条规矩照样在，只是不再依赖主检出所在分支。
//
// 退出码：0 同步都对；1 有没做成的（含同步专用的检出建不起来）；2 有没查成的；64 用法不对。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type GitResult, readRecord, recordFile } from './position.ts';
import type { Platform } from './targets.ts';

export const NOW_USAGE = `pnpm agents:sync —— 现在就把这台机器同步到主线最新（规矩、技能、钩子、权限），逐项报结果

用法：
  pnpm agents:sync             取远端、把同步专用的检出切到 origin/main、跑 agents-sync --apply
  pnpm agents:sync --check     只读：不取远端、不切、不写，只报这台和仓里（上次取到的主线）差在哪
  pnpm agents:sync --offline   不取远端（取不到时用），按本机上次取到的 origin/main 同步
  pnpm agents:sync --seed <目录>   拿这个 fleet-dao 检出当种子（第一次建专用检出、或它坏了要重建时用；
                                默认：~/.fleet-dao/synced.json 记的那个检出，再没有就是本脚本所在的检出）

同步专用的检出在 ~/.fleet-dao/origin-main，永远停在 origin/main 上；这台机器自己的 fleet-dao 检出一个字都不动
（在哪个分支、有没有没提交的改动都不影响同步）。

已开着的 AI 会话读的是开场时的规矩，同步完要重开会话才生效。
退出码：0 都对；1 有没做成的；2 有没查成的；64 用法不对。
`;

/** 同步那一段（agents/hooks/sync-source.mjs）：和开会话钩子走同一份，免得两边两套判断 */
const SOURCE = new URL('../../../agents/hooks/sync-source.mjs', import.meta.url).href;

export interface NowDeps {
  home: string;
  platform: Platform;
  /** 本脚本所在的检出（没记过别的时拿它当种子） */
  defaultRepo: string;
  /** 在 dir 里跑一条 git（读）：超时 15 秒 */
  git: (dir: string, args: string[]) => GitResult;
  /** 在 dir 里跑一条取远端的 git：比读慢，超时另算（60 秒） */
  fetch: (dir: string, args: string[]) => GitResult;
  /** 用检出里的 agents-sync 跑一遍，输出直接给用户看；返回退出码，跑不起来是错误 */
  sync: (repo: string, mode: '--apply' | '--check') => { status: number | null; error?: Error | undefined };
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface Args {
  mode: '--apply' | '--check';
  offline: boolean;
  seed?: string;
}

function parse(argv: readonly string[]): Args | 'help' | string {
  const out: Args = { mode: '--apply', offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return 'help';
    if (a === '--check') out.mode = '--check';
    else if (a === '--offline') out.offline = true;
    // --repo 是原来的名字，留着：意思一样（给一个 fleet-dao 检出当种子）
    else if (a === '--seed' || a === '--repo') {
      const v = argv[++i];
      if (!v) return `${a} 后面要跟目录`;
      out.seed = v;
    } else return `认不出的参数 ${a}`;
  }
  return out;
}

const short = (sha: string): string => sha.slice(0, 7);
const ok = (r: GitResult): boolean => r.status === 0 && !r.error;

/** 一条 git 为什么没成：超时、起不来，或者第一行输出；Windows 上程序没起来会给很大的退出码 */
function why(r: GitResult): string {
  if (r.error) return (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? '超时' : r.error.message;
  const first = `${r.stderr}\n${r.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (first) return first;
  if (typeof r.status === 'number' && r.status > 0x7fffffff)
    return `退出码 ${r.status}（0x${r.status.toString(16).toUpperCase()}，Windows 上程序没起来，多半缺 DLL）`;
  return `退出码 ${r.status}`;
}

interface SourcePrepared {
  ok: boolean;
  dir: string;
  head?: string;
  repaired?: boolean;
  fresh?: boolean;
  moved?: boolean;
  unchecked?: boolean;
  why?: string;
}

interface SourceLib {
  syncDirIn(home: string): string;
  lockFileIn(home: string): string;
  gitRunner(timeoutMs?: number): (dir: string, args: string[], opts?: { timeoutMs?: number }) => GitResult;
  prepareSource(
    home: string,
    seed: string | null,
    options: {
      check?: boolean;
      offline?: boolean;
      repair?: boolean;
      deps?: { git?: (dir: string, args: string[], opts?: { timeoutMs?: number }) => GitResult };
    },
  ): SourcePrepared;
  takeSourceLock(
    home: string,
    deps?: { now?: number; pid?: number },
  ): { ok: true; release: () => void } | { ok: false; why: string };
}

export async function syncNow(argv: readonly string[], deps: NowDeps): Promise<number> {
  const args = parse(argv);
  if (args === 'help') {
    deps.stdout(NOW_USAGE);
    return 0;
  }
  if (typeof args === 'string') {
    deps.stderr(`${args}\n\n${NOW_USAGE}`);
    return 64;
  }
  const fail = (msg: string): number => {
    deps.stderr(`一键同步没做：${msg}\n`);
    return 1;
  };

  let source: SourceLib;
  try {
    source = (await import(SOURCE)) as unknown as SourceLib;
  } catch (err) {
    return fail(
      `读不了同步那一段（${(err as Error).message ?? err}）；这个检出不全，或 agents/hooks/ 没装上`,
    );
  }

  // 这台的 git 能不能起来，先问一句
  const alive = deps.git(deps.home, ['--version']);
  if (!ok(alive)) return fail(`这台的 git 跑不起来（${why(alive)}），没法同步`);

  // 种子：--seed/--repo 指的，否则 ~/.fleet-dao/synced.json 记的检出，再没有就是本脚本所在的检出。
  // 记录读不懂不当场失败：专用检出在的话照样能同步，那一下会把记录重写一份。
  let seed: string | undefined = args.seed;
  let recordNote = '';
  if (seed === undefined) {
    const rec = readRecord(recordFile(deps.home, deps.platform).file);
    if (rec.ok) seed = rec.value?.repo ?? deps.defaultRepo;
    else {
      recordNote = `~/.fleet-dao/synced.json ${rec.why}，这次同步会重写一份`;
      seed = deps.defaultRepo;
    }
  }
  if (seed !== undefined && !existsSync(join(seed, 'packages', 'agents-sync', 'bin', 'agents-sync'))) {
    if (args.seed !== undefined)
      return fail(
        `${seed} 不是 fleet-dao 检出（没有 packages/agents-sync）；用 --seed <fleet-dao 检出> 指定`,
      );
    seed = undefined; // 本脚本所在的检出也不是（打包运行之类）：那就没有种子，靠专用检出自己
  }
  if (recordNote) deps.stdout(`${recordNote}。\n`);

  // 取远端比读慢（读 15 秒、取 60 秒），这条路上的 fetch 单独走 deps.fetch。
  // 签名按 sync-source 那份：git(dir, args, opts)。那边给的 opts.timeoutMs 这里用不上——取远端的超时由 deps.fetch 定
  const prepGit = (dir: string, args: string[], opts: { timeoutMs?: number } = {}): GitResult => {
    void opts;
    return args[0] === 'fetch' ? deps.fetch(dir, args) : deps.git(dir, args);
  };

  const lock = source.takeSourceLock(deps.home);
  if (!lock.ok) {
    const lag = lagText(source, deps.git, deps.home, deps.platform);
    return fail(`${lock.why}；${lag}`);
  }
  try {
    const prepared = source.prepareSource(deps.home, seed ?? null, {
      check: args.mode === '--check',
      offline: args.offline,
      repair: args.mode === '--apply',
      deps: { git: prepGit },
    });
    if (!prepared.ok) {
      const lag = lagText(source, deps.git, deps.home, deps.platform);
      const code = prepared.unchecked === true ? 2 : 1;
      deps.stderr(`一键同步没做：${prepared.why}${prepared.unchecked === true ? `\n${lag}\n` : '\n'}`);
      return code;
    }
    const head = String(prepared.head ?? '');
    if (prepared.repaired === true)
      deps.stdout(
        `同步专用的检出 ${prepared.dir} ${prepared.fresh === true ? '建好了' : '修好了一份（原来那份挪到旁边留着了）'}，在主线 ${short(head)}。\n`,
      );
    else if (prepared.moved === true)
      deps.stdout(`同步专用的检出 ${prepared.dir} 切到了主线 ${short(head)}。\n`);
    else deps.stdout(`同步专用的检出 ${prepared.dir} 本来就在主线 ${short(head)}。\n`);

    const r = deps.sync(prepared.dir, args.mode);
    if (r.error || r.status === null) {
      deps.stderr(`一键同步没跑成：agents-sync 起不来（${r.error?.message ?? '没有退出码'}）\n`);
      return 1;
    }
    if (r.status === 0) {
      deps.stdout(
        args.mode === '--apply'
          ? '一键同步完成：逐项结果见上面，每家一行。已开着的 AI 会话读的是开场时的规矩，重开会话才生效。\n'
          : '只读检查完成：逐项结果见上面。\n',
      );
      return 0;
    }
    deps.stderr(
      `一键同步没全成（agents-sync 退出码 ${r.status}）：看上面标 ✗ 的（没做成、漂移、缺失）和标 … 的（没查成）几行。\n`,
    );
    return r.status === 2 ? 2 : 1;
  } finally {
    lock.release();
  }
}

/** 这台机器上一次同步到哪个提交、落后主线几个（在专用检出里算，不出网；算不了就说算不了） */
function lagText(source: SourceLib, git: NowDeps['git'], home: string, platform: Platform): string {
  const rec = readRecord(recordFile(home, platform).file);
  const synced =
    rec.ok && typeof rec.value?.synced?.commit === 'string' ? rec.value.synced.commit : undefined;
  if (!synced) return '这台还没记过同步到哪个提交';
  const r = git(source.syncDirIn(home), ['rev-list', '--count', `${synced}..refs/remotes/origin/main`]);
  const n = Number(r.stdout.trim());
  if (!ok(r) || r.stdout.trim() === '' || !Number.isInteger(n))
    return `这台同步到 ${short(synced)}，和主线比不了（${why(r)}）`;
  return n === 0
    ? `这台同步到 ${short(synced)}，没落后主线`
    : `这台同步到 ${short(synced)}，落后主线 ${n} 个提交`;
}

/** 真的 git：读 15 秒，取远端 60 秒 */
export function realGit(timeoutMs: number): (dir: string, args: string[]) => GitResult {
  return (dir, args) => {
    const r = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
}

/** 真的 agents-sync：用专用检出里的那份（就是 origin/main 上的），输出直接接到终端 */
export function realSync(
  repo: string,
  mode: '--apply' | '--check',
): { status: number | null; error?: Error } {
  const bin = join(repo, 'packages', 'agents-sync', 'bin', 'agents-sync');
  const r = spawnSync(process.execPath, [bin, mode, '--repo', repo], { stdio: 'inherit', windowsHide: true });
  return { status: r.status, ...(r.error ? { error: r.error } : {}) };
}
