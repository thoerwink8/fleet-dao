// 命令行：解析参数、（要的话）换成目标用户的身份、跑一种模式、打印结论、给退出码。
// 和系统打交道的几样（身份、查用户、PATH）都从 deps 进来，测试换成假的。
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Backups } from './backup.ts';
import { installedAgents } from './detect.ts';
import { manifestPath, readManifest } from './manifest.ts';
import { exitCode, type Line, render, summary } from './report.ts';
import { retireOld } from './retire.ts';
import {
  applyRules,
  applySkills,
  type Ctx,
  checkRules,
  checkSkills,
  readSources,
  type Sources,
  verify,
} from './sync.ts';
import type { Platform } from './targets.ts';

export const USAGE = `agents-sync —— 把 fleet-dao 仓里 AGENTS.md 的通用段和 agents/skills/ 分发到这台机器上各家 AI 的全局入口

用法（三种模式挑一种）：
  agents-sync --check        只读：逐家报 一致 / 漂移 / 缺失 / 没装（跳过）/ 没查成
  agents-sync --apply        写：通用段写进各家的全局文件（只动标记圈起来的那一块；第一次接管先整份备份），
                             skill 拷进各家的 skill 目录（只动清单里记着是本脚本装的），写完照查一遍
  agents-sync --retire-old --old-repo <旧仓的位置>
                             撤掉旧仓留下的东西：各家 skill 目录里指向旧仓的链接、~/.claude/agents 里两个旧子代理；
                             每项先备份再动

选项：
  --home <目录>      家目录（默认：当前用户的家；带 --user 时是那个用户的家）
  --user <用户名>    替这个用户做（Linux，要 root）：先换成他的身份再动手，写出来的东西都归他
  --repo <目录>      fleet-dao 仓的位置（默认：本脚本所在的仓）
  --old-repo <目录>  旧仓在这台机器上的位置（--retire-old 要）

每项一行：✓ 一致、↻ 这次改了、✗ 漂移 / 缺失 / 没做成、… 没查成、· 没装（跳过）。
退出码：0 都对（没装的不算）；1 有漂移、缺失或没做成；2 没有 ✗ 但有没查成的；64 用法不对。
清单在 ~/.fleet-dao/agents-sync.json，备份在 ~/.fleet-dao/backups/<时间>/。
`;

export interface PasswdEntry {
  uid: number;
  gid: number;
  home: string;
}

export interface Deps {
  platform: Platform;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => Date;
  /** 当前用户的家目录 */
  homedir: () => string;
  /** 本脚本所在的仓 */
  defaultRepo: string;
  /** Windows 上没有，返回 undefined */
  getuid: () => number | undefined;
  lookupUser: (name: string) => PasswdEntry | undefined;
  /** 换成这个用户的身份（附加组、组、用户），换不过去就抛 */
  becomeUser: (name: string, entry: PasswdEntry) => void;
}

type Mode = '--check' | '--apply' | '--retire-old';

interface Args {
  mode: Mode;
  home?: string;
  user?: string;
  repo?: string;
  oldRepo?: string;
}

class UsageError extends Error {}

function parse(argv: readonly string[]): Args | 'help' {
  const modes: Mode[] = [];
  const opts: Omit<Args, 'mode'> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return 'help';
    if (a === '--check' || a === '--apply' || a === '--retire-old') {
      modes.push(a);
      continue;
    }
    const takes: Record<string, keyof typeof opts> = {
      '--home': 'home',
      '--user': 'user',
      '--repo': 'repo',
      '--old-repo': 'oldRepo',
    };
    const field = a === undefined ? undefined : takes[a];
    if (field === undefined) throw new UsageError(`认不出的参数：${a}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${a} 后面要跟一个值`);
    opts[field] = value;
    i++;
  }
  if (modes.length !== 1) throw new UsageError('--check、--apply、--retire-old 要挑一个，也只能挑一个');
  const mode = modes[0] as Mode;
  if (mode === '--retire-old' && opts.oldRepo === undefined) {
    throw new UsageError('--retire-old 要带 --old-repo <旧仓的位置>');
  }
  if (mode !== '--retire-old' && opts.oldRepo !== undefined)
    throw new UsageError('--old-repo 只给 --retire-old 用');
  return { mode, ...opts };
}

/** 定下家目录；带 --user 的先换身份。原件要在换身份之前读好（换过去之后未必读得到仓） */
function settleIdentity(args: Args, deps: Deps): { home: string; who: string } {
  if (args.user === undefined) {
    const home = resolve(args.home ?? deps.homedir());
    // root 直接往别人的家里写，写出来的东西归 root，那个用户自己改不动（留下 root 属主的文件是装机的红线）
    if (deps.platform === 'linux' && deps.getuid() === 0 && args.mode !== '--check') {
      let owner: number | undefined;
      try {
        owner = statSync(home).uid;
      } catch {
        owner = undefined;
      }
      if (owner !== undefined && owner !== 0) {
        throw new UsageError(
          `${home} 不归 root：以 root 直接写会留下 root 属主的文件，加 --user <那个用户> 再跑`,
        );
      }
    }
    return { home, who: '' };
  }
  if (deps.platform !== 'linux')
    throw new UsageError('--user 只在 Linux 上用；Windows 上在那个用户自己的会话里跑');
  const entry = deps.lookupUser(args.user);
  if (entry === undefined) throw new UsageError(`没有用户 ${args.user}`);
  const me = deps.getuid();
  if (me !== entry.uid) {
    if (me !== 0) throw new UsageError(`替 ${args.user} 做要 root（现在是 uid ${me ?? '读不到'}）`);
    deps.becomeUser(args.user, entry);
  }
  return { home: resolve(args.home ?? entry.home), who: `用户 ${args.user}，` };
}

export function runCli(argv: readonly string[], deps: Deps): number {
  let args: Args | 'help';
  try {
    args = parse(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`${err.message}\n\n${USAGE}`);
      return 64;
    }
    throw err;
  }
  if (args === 'help') {
    deps.stdout(USAGE);
    return 0;
  }

  // 仓里的原件先读好（换身份之前）；读不到就是没查成，不往下走
  let sources: Sources | undefined;
  if (args.mode !== '--retire-old') {
    const repo = resolve(args.repo ?? deps.defaultRepo);
    const read = readSources(repo);
    if (!read.ok) {
      deps.stderr(`没查成：${read.why}（仓：${repo}）\n`);
      return 2;
    }
    sources = read.value;
  }
  let oldRepo: string | undefined;
  if (args.oldRepo !== undefined) {
    if (!isAbsolute(args.oldRepo)) {
      deps.stderr(`--old-repo 要写绝对路径：${args.oldRepo}\n`);
      return 64;
    }
    oldRepo = resolve(args.oldRepo);
  }

  let home: string;
  let who: string;
  try {
    ({ home, who } = settleIdentity(args, deps));
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`${err.message}\n`);
      return 64;
    }
    deps.stderr(`没查成：换不成 ${args.user} 的身份（${(err as Error).message}）\n`);
    return 2;
  }
  try {
    if (!statSync(home).isDirectory()) throw new Error('不是目录');
  } catch {
    deps.stderr(`没查成：家目录 ${home} 不在\n`);
    return 2;
  }

  const platformName = deps.platform === 'win32' ? 'Windows' : 'Linux';
  const title = { '--check': '查', '--apply': '写', '--retire-old': '撤旧仓' }[args.mode];
  deps.stdout(`agents-sync ${args.mode}（${title}；${who}家目录 ${home}；${platformName}）\n`);

  const backups = new Backups(home, deps.platform, deps.now());
  const all: Line[] = [];
  const section = (heading: string, lines: Line[]): void => {
    deps.stdout(`${heading}\n${render(lines)}`);
    all.push(...lines);
  };

  if (args.mode === '--retire-old') {
    section(
      '旧仓留下的东西',
      retireOld({ home, platform: deps.platform, oldRepo: oldRepo as string }, backups),
    );
  } else {
    const src = sources as Sources;
    const ctx: Ctx = {
      home,
      platform: deps.platform,
      installed: installedAgents({ env: deps.env, platform: deps.platform, home }),
    };
    const mf = manifestPath(home, deps.platform);
    if (args.mode === '--check') {
      section('通用段（AGENTS.md 上半段）', checkRules(ctx, src));
      section('skill（agents/skills/）', checkSkills(ctx, src, readManifest(mf)));
    } else {
      const rules = applyRules(ctx, src, backups);
      section('通用段（AGENTS.md 上半段）', rules);
      const skills = applySkills(ctx, src, readManifest(mf));
      section('skill（agents/skills/）', skills);
      const after = [...checkRules(ctx, src), ...checkSkills(ctx, src, readManifest(mf))];
      const bad = verify([...rules, ...skills], after);
      if (bad.length) section('读回', bad);
    }
  }
  deps.stdout(summary(all));
  return exitCode(all);
}
