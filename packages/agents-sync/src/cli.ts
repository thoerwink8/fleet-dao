// 命令行：解析参数、（要的话）换成目标用户的身份、跑一种模式、打印结论、给退出码。
// 和系统打交道的几样（身份、查用户、PATH、git）都从 deps 进来，测试换成假的。
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Backups } from './backup.ts';
import { installedAgents } from './detect.ts';
import { applyGitExcludes, checkGitExcludes } from './git-excludes.ts';
import { applyHooks, checkHooks, type HookSkip } from './hooks.ts';
import { takeLock } from './lock.ts';
import { manifestPath, readManifest } from './manifest.ts';
import { applyMcp, checkMcp } from './mcp.ts';
import { applyPermissions, checkPermissions } from './permissions.ts';
import { applyOtherPermissions, checkOtherPermissions } from './permissions-vendors.ts';
import { applyPosition, checkPosition, type Git, type Position, readPosition, runGit } from './position.ts';
import { exitCode, type Line, line, render, summary } from './report.ts';
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
import { applyToolConfig, checkToolConfig } from './tool-config.ts';

export const USAGE = `agents-sync —— 把 fleet-dao 仓里 AGENTS.md 的通用段、agents/skills/（自研）、agents/skills-vendor/（第三方，照锁文件核过才发）、agents/hooks/ 分发到这台机器上各家 AI 的全局入口

用法（三种模式挑一种）：
  agents-sync --check        只读：逐家报 一致 / 漂移 / 缺失 / 没装（跳过）/ 没查成；最后报这台同步到哪个提交、落后主线几个
  agents-sync --apply        写：通用段写进各家的全局文件（只动标记圈起来的那一块；第一次接管先整份备份），
                             skill 拷进各家的 skill 目录（只动清单里记着是本脚本装的），
                             钩子脚本拷进 ~/.fleet-dao/hooks/、在各家设置里登记（只动指向它们的那几条），
                             agents/config/claude-permissions.json 合进 ~/.claude/settings.json 的 permissions
                             （defaultMode 覆盖；allow、deny 补缺、不删机器上自己加的；相反的、读不懂的不动、报出来）
                             和同一份设置的 autoMode（给 auto 模式分类器看的自然语言规则：environment、allow
                             按并集合并、不删机器上自己加的；源文件里少了 "$defaults" 就拒收——没它 Claude Code
                             会把那一类的内置规则整段换掉），
                             和同一份设置 env 里的子代理默认模型（CLAUDE_CODE_SUBAGENT_MODEL：只认 Opus 或 Sonnet，
                             每次覆盖，env 里别的变量不碰；源文件少了它或写成别的就拒收，决定 0017），
                             并翻译成 Kimi（config.toml 里一块托管块加默认模式）、Codex（rules/default.rules 里一块托管块）、
                             Devin（config.json 的 permissions）各自的写法；Grok 直接读 Claude 那份，不另写，
                             _tmp/ 加进这台的 git 全局忽略（core.excludesFile 没设过就新建一份；已经指到别的文件，
                             就在那份文件里接管一小块，不碰其余内容），
                             各家配置文件里本脚本管的几个开关改成该有的值（targets.ts 的 CONFIG_KEY_TARGETS，比如
                             ~/.grok/config.toml 的目录信任、反问选择题；别的内容不碰，读不懂就不动、报出来），
                             ~/.claude.json 里 mcpServers.playwright 已经配了的那条 args 加上 --output-dir
                             _tmp/playwright（已经有这个参数但值不对的改成这个值；这台没配 Playwright MCP 的
                             跳过、不新增；读不懂就不动、报出来），
                             写完照查一遍，记下这台同步到哪个提交
  agents-sync --retire-old --old-repo <旧仓的位置>
                             撤掉旧仓留下的东西：各家 skill 目录里指向旧仓的链接、~/.claude/agents 里两个旧子代理；
                             每项先备份再动

选项：
  --home <目录>      家目录（默认：当前用户的家；带 --user 时是那个用户的家）
  --user <用户名>    替这个用户做（Linux，要 root）：先换成他的身份再动手，写出来的东西都归他；开会话钩子不登记、权限不写、同步位置不记
                     （调工具前、Stop 那两条钩子，还有全局 git 忽略都照写：不需要会话、不用等自动发布，
                     写出来的东西也归他）
  --repo <目录>      fleet-dao 仓的位置（默认：本脚本所在的仓）
  --old-repo <目录>  旧仓在这台机器上的位置（--retire-old 要）

每项一行：✓ 一致、↻ 这次改了、✗ 漂移 / 缺失 / 没做成、… 没查成、· 没装（跳过）。
退出码：0 都对（没装的不算）；1 有漂移、缺失或没做成；2 没有 ✗ 但有没查成的（含另一个同步正在写）；64 用法不对。
清单在 ~/.fleet-dao/agents-sync.json，同步位置在 ~/.fleet-dao/synced.json，备份在 ~/.fleet-dao/backups/<时间>/。
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
  /** 跑 git（默认真的 git）；测试可换 */
  git?: Git;
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

interface Identity {
  home: string;
  who: string;
  /** 要换身份时换（先读好仓、问好 git 再调）；不用换是 null */
  become: (() => void) | null;
}

/** 定下家目录、要不要换身份；真换身份留给调用方（原件和 git 的事要在换身份之前做完） */
function planIdentity(args: Args, deps: Deps): Identity {
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
    return { home, who: '', become: null };
  }
  if (deps.platform !== 'linux')
    throw new UsageError('--user 只在 Linux 上用；Windows 上在那个用户自己的会话里跑');
  const user = args.user;
  const entry = deps.lookupUser(user);
  if (entry === undefined) throw new UsageError(`没有用户 ${user}`);
  const me = deps.getuid();
  if (me !== entry.uid && me !== 0)
    throw new UsageError(`替 ${user} 做要 root（现在是 uid ${me ?? '读不到'}）`);
  return {
    home: resolve(args.home ?? entry.home),
    who: `用户 ${user}，`,
    become: me === entry.uid ? null : () => deps.becomeUser(user, entry),
  };
}

/**
 * 替别的用户写（法国装机）时开会话那条钩子不登记：它要在这个用户自己能拉、能写的 fleet-dao 检出里快进、同步，法国的检出跟着
 * 自动发布走。调工具前那条照装：会话用户家里就有 reclaude 的设备密钥，在那台上手开的会话、借道读 ~/.claude/settings.json
 * 的 Grok、Cursor 起的会话都要拦读密钥文件。引擎起的 Claude 会话带 --setting-sources project、不读用户级设置，这里装了
 * 也管不到它（packages/adapters/src/claude-code/args.ts），要管得由引擎另外带上。
 */
const SESSION_START_OFF_FOR_USER: HookSkip = {
  event: 'SessionStart',
  why: '替别的用户写（--user）时不登记开会话钩子：它要在这个用户自己能拉、能写的 fleet-dao 检出里快进、同步，法国的检出跟着自动发布走',
};
/** 权限整段不写：defaultMode auto 会让那台上的 AI 会话少一道人工确认，法国的工人会话要不要放开由引擎自己带的参数定，不靠共用的用户级设置 */
const PERMISSIONS_OFF_FOR_USER =
  '替别的用户写（--user）时不写权限：defaultMode auto 会让那个用户的 AI 会话少一道确认，法国的会话放不放开由引擎起会话时的参数定，不靠用户级设置';
// 法国的检出由自动发布推进，停在发出去的那个提交上，本来就可能落后主线（等 CI、等引擎空闲）：
// 拿主线比会把正常的等待判红、让自动发布误报「规矩同步没成」。同步到哪个提交记在自动发布的读数里（ops 第九节）。
const POSITION_OFF_FOR_USER =
  '替别的用户写（--user）时不记同步位置：法国的规矩跟着自动发布走，同步到哪个提交、落后主线多少看自动发布的读数（release.sh --check）';
// ~/.claude.json 是 Claude Code 每次会话自己都要读写的活文件，替别的用户写超出 #380 定的范围；
// 那边工人会话要不要 Playwright、输出的目录，由引擎起会话时自己带参数定，不靠用户级的这份。
const MCP_OFF_FOR_USER =
  '替别的用户写（--user）时不管 MCP 服务器配置（~/.claude.json）：那份是 Claude Code 每次会话自己读写的活文件，替别的用户写超出这张单的范围';

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
  const repo = resolve(args.repo ?? deps.defaultRepo);
  if (args.mode !== '--retire-old') {
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

  let id: Identity;
  try {
    id = planIdentity(args, deps);
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`${err.message}\n`);
      return 64;
    }
    throw err;
  }
  // 同步位置：记录和 git 的事在换身份之前问好（换过去之后未必读得到仓，git 也会因为属主不同拒读）
  const position: Position | undefined =
    args.mode === '--retire-old' || args.user !== undefined
      ? undefined
      : readPosition(repo, id.home, deps.platform, deps.git ?? runGit);
  try {
    id.become?.();
  } catch (err) {
    deps.stderr(`没查成：换不成 ${args.user} 的身份（${(err as Error).message}）\n`);
    return 2;
  }
  const { home, who } = id;
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

  // 写的两种模式先拿写锁：几个会话同时开，开会话钩子会同时跑同步
  let release: (() => void) | undefined;
  if (args.mode !== '--check') {
    const lock = takeLock(home, deps.platform, deps.now());
    if (!lock.ok) {
      section('写锁', [line('unknown', lock.key, `没做成——${lock.why}`)]);
      deps.stdout(summary(all));
      return exitCode(all);
    }
    release = lock.release;
  }
  try {
    if (args.mode === '--retire-old') {
      section(
        '旧仓留下的东西',
        retireOld({ home, platform: deps.platform, oldRepo: oldRepo as string }, backups),
      );
    } else {
      const src = sources as Sources;
      const positionOff = [line('skip', '同步位置', POSITION_OFF_FOR_USER)];
      const ctx: Ctx = {
        home,
        platform: deps.platform,
        installed: installedAgents({ env: deps.env, platform: deps.platform, home }),
      };
      const hooksOff = args.user === undefined ? undefined : SESSION_START_OFF_FOR_USER;
      const permsOff = args.user === undefined ? undefined : PERMISSIONS_OFF_FOR_USER;
      const mcpOff = args.user === undefined ? undefined : MCP_OFF_FOR_USER;
      const mcpSection = 'MCP 服务器（~/.claude.json 里的 Playwright 输出目录）';
      const mf = manifestPath(home, deps.platform);
      if (args.mode === '--check') {
        section('通用段（AGENTS.md 上半段）', checkRules(ctx, src));
        section('skill（agents/skills/、agents/skills-vendor/）', checkSkills(ctx, src, readManifest(mf)));
        section('钩子（agents/hooks/）', checkHooks(ctx, src, hooksOff));
        section('权限（agents/config/claude-permissions.json）', checkPermissions(ctx, src, permsOff));
        section('其他几家 AI 的权限（Kimi、Codex、Devin）', checkOtherPermissions(ctx, src, permsOff));
        section('全局 git 忽略（_tmp/）', checkGitExcludes(ctx));
        section('各家配置里的开关', checkToolConfig(ctx));
        section(mcpSection, mcpOff ? [line('skip', 'MCP', mcpOff)] : checkMcp(ctx));
        section('同步位置', position ? checkPosition(position) : positionOff);
      } else {
        const rules = applyRules(ctx, src, backups);
        section('通用段（AGENTS.md 上半段）', rules);
        const skills = applySkills(ctx, src, readManifest(mf));
        section('skill（agents/skills/、agents/skills-vendor/）', skills);
        const hooks = applyHooks(ctx, src, backups, hooksOff);
        section('钩子（agents/hooks/）', hooks);
        const perms = applyPermissions(ctx, src, backups, permsOff);
        section('权限（agents/config/claude-permissions.json）', perms);
        const otherPerms = applyOtherPermissions(ctx, src, backups, permsOff);
        section('其他几家 AI 的权限（Kimi、Codex、Devin）', otherPerms);
        const config = applyToolConfig(ctx, backups);
        section('各家配置里的开关', config);
        const mcp = mcpOff ? [line('skip', 'MCP', mcpOff)] : applyMcp(ctx, backups);
        section(mcpSection, mcp);
        const after = [
          ...checkRules(ctx, src),
          ...checkSkills(ctx, src, readManifest(mf)),
          ...checkHooks(ctx, src, hooksOff),
          ...checkPermissions(ctx, src, permsOff),
          ...checkOtherPermissions(ctx, src, permsOff),
          ...checkToolConfig(ctx),
          ...(mcpOff ? [] : checkMcp(ctx)),
        ];
        const bad = verify(
          [...rules, ...skills, ...hooks, ...perms, ...otherPerms, ...config, ...mcp],
          after,
        );
        if (bad.length) section('读回', bad);
        section('全局 git 忽略（_tmp/）', applyGitExcludes(ctx, backups));
        section('同步位置', position ? applyPosition(position, all, deps.now()) : positionOff);
      }
    }
  } finally {
    release?.();
  }
  deps.stdout(summary(all));
  return exitCode(all);
}
