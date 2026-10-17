// 推送前的本机预检（.githooks/pre-push 调它）：把「CI 上一定会跑、判法又确定」的那几样在推之前跑一遍，红了当场修，
// 不用等几分钟 CI 回来才知道。CI 慢的大头不是机器慢，是「红了、改、重推、再跑一遍」这个来回。
//
// 只跑改到的部分：该跑什么由 ci-plan 现算（`planCi`，和 CI 同一份判法）——纯文档的改动什么都不跑，改到一个包就只
// 跑那个包和依赖它的包。本机实测（Windows，比 CI 的机器慢）：biome 全仓 2.3 秒、tsc -b 全树 1.5 秒，所以这两样按
// 整个仓跑也不心疼；vitest 慢，这里不跑（交 `pnpm test:changed`，它另有内存上限那套规矩）。
//
// 改这里之前必须知道：
// - 跑什么一律问 ci-plan，不在这里另写一套「改动落在哪」的判法：两边判法一旦分叉，「本机过了 CI 红」照旧发生。
// - 查不成（git 读不到基准、依赖没装、命令起不来）一律拒推并写明是「没查成」，不许当场「检查通过」——这是公开仓
//   的推前闸门，底线第三条：没查成不算过。
// - 只放确定的检查。要网络、要时间、会偶发不稳的（deploy 全套、Temporal、香港）都留给 CI，不在这里跑。
import { type PackageGraph, planCi } from './ci-plan.ts';
import type { RepoView } from './repo.ts';
import { BASE, type GitRun } from './test-changed.ts';

export interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** 起不来（找不到命令）时有值；和「命令跑了但失败」分开。 */
  error?: Error | undefined;
}

/**
 * `pushedFiles` 读出来的这次推送。null 不在这个类型里：那是「读不出来」，调用方走老路，不能和「全是删分支」混成一个空结果。
 * - `files`：删分支以外、实际推上去的提交改到的文件（可能为空，空不算「只有图片」）。
 * - `delete-only`：ref 行非空，且每一行都是删分支（本地 sha 全 0）。没有新内容。
 */
export type PushedFilesResult = { kind: 'files'; files: string[] } | { kind: 'delete-only' };

export interface PreparePushDeps {
  /** 这次改了哪些文件（仓内相对路径）。读不成抛，由调用方记「没查成」。 */
  changed: () => string[];
  repo: RepoView;
  graph: () => PackageGraph | string;
  /** 跑一条命令（cwd 是仓根），同步。 */
  run: (cmd: string, args: readonly string[]) => CmdResult;
  /** 这次推送的内容（`pushedFiles`）。读不出来返回 null；不给就一律走老路。 */
  pushed?: () => PushedFilesResult | null;
}

export interface PreparePushResult {
  /** 0 = 都过了（或没东西要跑）；1 = 查出来红了；2 = 没查成（拒推，和卫生检查一个口径）。 */
  code: number;
  lines: string[];
}

interface Step {
  name: string;
  cmd: string;
  args: string[];
  /**
   * 「这条命令真的跑到检查了」的证据（它自己的输出里才有）。命令退出码非 0、却拿不出这个证据，就是没跑起来
   * （路径不对、依赖没装、被 shell 拦了……），不是代码没过。不去猜各种起不来的报错长什么样——那一串报错
   * 是开放集合（cmd.exe 的「系统找不到指定的路径」、node 的 MODULE_NOT_FOUND、以后还会有新的）。
   */
  ran: RegExp;
}

// biome 查完一定会打这一行汇总（过了、没过都有）；0 个文件算没查到东西（路径/配置不对），也不是格式没过。
const BIOME_RAN = /Checked [1-9]\d* files? in /;
// tsc 判出类型错一定是 `error TS1234:` 这个格式（含读不到 tsconfig 的 TS5083，那是仓里的真问题）。
const TSC_RAN = /error TS\d+/;

export function preparePush(deps: PreparePushDeps): PreparePushResult {
  // 只删远端分支：不往公开仓推任何新内容（卫生检查那边也是零个提交）。跑格式和类型检查只是在查当前检出。
  // 只推图片（截图分支）同样没意义。拿不准（读不出、混了非图片、没有 ref、夹着解析不了的行）一律照查，不放行。
  // 删分支和推新内容混在一次里：删的那几行丢掉，只按推上去的内容判。
  let pushed: PushedFilesResult | null = null;
  try {
    pushed = deps.pushed?.() ?? null;
  } catch {
    pushed = null;
  }
  if (pushed?.kind === 'delete-only') {
    return { code: 0, lines: ['推送前预检：只删分支，没有新内容，跳过格式和类型检查'] };
  }
  if (pushed?.kind === 'files' && allImages(pushed.files)) {
    return { code: 0, lines: ['推送前预检：只推了图片，跳过格式和类型检查'] };
  }
  let changed: string[];
  try {
    changed = deps.changed();
  } catch (e) {
    return { code: 2, lines: [`推送前预检没查成：${e instanceof Error ? e.message : String(e)}`] };
  }
  const plan = planCi({ event: 'pull_request', changed, graph: deps.graph() });
  const steps: Step[] = [];
  if (plan.biome) steps.push({ name: 'biome 格式检查', cmd: 'biome', args: ['check', '.'], ran: BIOME_RAN });
  if (plan.tsc === 'all' || plan.tsc.length > 0) {
    steps.push({
      name: 'tsc 类型检查',
      cmd: 'tsc',
      args: plan.tsc === 'all' ? ['-b'] : ['-b', ...plan.tsc],
      ran: TSC_RAN,
    });
  }
  if (steps.length === 0) {
    return {
      code: 0,
      lines: [
        `推送前预检：这次改了 ${changed.length} 个文件，都在不需要代码检查的地方（和 CI 同一份判法），没有要跑的`,
      ],
    };
  }
  const lines: string[] = [
    `推送前预检：${changed.length} 个改动 → 跑 ${steps.map((s) => s.name).join('、')}（和 CI 同一份判法）`,
  ];
  for (const step of steps) {
    const r = deps.run(step.cmd, step.args);
    if (r.error) {
      return {
        code: 2,
        lines: [...lines, `${step.name} 没查成：${step.cmd} 起不来（${r.error.message}）——先 pnpm install`],
      };
    }
    // 启动器起来了、但它要的包没装全（工作树里 node_modules 不完整）：node 报 MODULE_NOT_FOUND 退 1，
    // 看着像「没过」其实是没查成——按 2 拒推，提示装依赖，别让人去改代码。
    if (r.status !== 0 && /MODULE_NOT_FOUND|Cannot find module/.test(`${r.stdout}${r.stderr}`)) {
      return {
        code: 2,
        lines: [...lines, `${step.name} 没查成：${step.cmd} 的依赖没装全（找不到模块）——先 pnpm install`],
      };
    }
    // biome 撞上「仓里嵌套着别的检出」：biome 按目录找配置，撞见一份没被 .gitignore 忽略的 biome.json 就报
    // 「a nested root configuration」退 1——整仓扫一遍全红，这台机器上**所有会话**的推送都被拦（
    // 出过一次：代理把工作树建到仓内 .worktrees/，攒了 60 多份嵌套配置）。这不是「没装依赖」，照着装依赖查
    // 一圈也找不到东西。工作是自己的工作树建到 .claude/worktrees/ 下（.gitignore 忽略、扫不到），或者把那份
    // 嵌套检出挪出仓；修完这一条，下面「没跑起来」那一段就不用猜了。
    if (r.status !== 0 && /nested root configuration/i.test(`${r.stdout}${r.stderr}`)) {
      const nested = [...`${r.stdout}${r.stderr}`.matchAll(/^\s*!?\s*(.+[\\/])biome\.json/gim)]
        .map((m) => m[1])
        .slice(0, 3);
      return {
        code: 2,
        lines: [
          ...lines,
          `${step.name} 没查成：仓里嵌套着别的检出（biome 报 nested root configuration）——不是代码没过、也不是缺依赖。${nested.length > 0 ? `在这几处：${nested.join('、')}；` : ''}把工作树建到 .claude/worktrees/ 下（已被忽略），或把那几份挪出仓，再推。`,
        ],
      };
    }
    if (r.status !== 0) {
      const tail = `${r.stdout}${r.stderr}`.trim().split('\n').slice(-40).join('\n');
      // 退出码非 0 但没有「真跑到检查」的证据：命令没跑起来（#789：新建工作树没装依赖时，cmd.exe 报
      // 「系统找不到指定的路径」退 1，看着像格式没过）。退 2 没查成，把原输出带出来，别让人去改代码。
      if (!step.ran.test(`${r.stdout}${r.stderr}`)) {
        return {
          code: 2,
          lines: [
            ...lines,
            `${step.name} 没查成：${step.cmd} 没跑起来（退出码 ${r.status}，输出里没有它的检查结果）——多半是没装依赖，先 pnpm install；装过还这样，看下面它自己的输出：`,
            tail,
          ],
        };
      }
      return { code: 1, lines: [...lines, `${step.name} 没过（退出码 ${r.status}）：`, tail] };
    }
    lines.push(`${step.name} 过了`);
  }
  return { code: 0, lines };
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const isZeroOid = (oid: string) => /^0+$/.test(oid);

/** 非空且全是图片（png、jpg、jpeg、webp、gif，大小写不分）。 */
export const allImages = (files: readonly string[]): boolean =>
  files.length > 0 && files.every((f) => IMAGE_EXT.test(f));

/**
 * 这次推送实际推上去的提交改到了哪些文件（不是当前检出对主线的差）。stdin 是 git 给钩子的行：
 * `<本地 ref> <本地 sha> <远端 ref> <远端 sha>`。本地 sha 全 0 是删分支。
 * ref 行非空、且每一行都是删分支 → `{ kind: 'delete-only' }`，不读 git（没有新内容可查）。
 * 删分支和推新内容混在一次里：删的那几行丢掉，只看推上去的。
 * 远端已有这个分支 → 从远端 sha 比到本地 sha；新分支 → 和主线有共同祖先就从祖先比，没有（孤儿分支）就是整棵树。
 * 一切读不出来（没有 ref 行、全是删分支却夹着解析不了的行、git 报错、认不出共同祖先）返回 null，调用方照老路全查，不放行。
 */
export function pushedFiles(stdin: string, git: GitRun, base = BASE): PushedFilesResult | null {
  const parsed = stdin
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split(/\s+/));
  const refs = parsed
    .filter((p) => p.length === 4)
    .map(([, localOid = '', , remoteOid = '']) => ({ localOid, remoteOid }));
  if (refs.length === 0) return null;
  const content = refs.filter((r) => !isZeroOid(r.localOid));
  if (content.length === 0) {
    // 非空行里夹着解析不了的：拿不准是不是还有别的推送，不当成「只删分支」放行。
    if (parsed.some((p) => p.length !== 4)) return null;
    return { kind: 'delete-only' };
  }
  const files = new Set<string>();
  const names = (args: readonly string[]): string[] | null => {
    const r = git(args);
    if (r.error || r.status !== 0) return null;
    return r.stdout.split('\0').filter((f) => f !== '');
  };
  for (const { localOid, remoteOid } of content) {
    let from: string;
    if (!isZeroOid(remoteOid)) {
      from = remoteOid;
    } else {
      const mb = git(['merge-base', base, localOid]);
      if (mb.error) return null;
      if (mb.status === 0) from = mb.stdout.trim();
      else if (mb.status === 1 && mb.stderr.trim() === '')
        from = ''; // 没有共同祖先：孤儿分支
      else return null;
      if (mb.status === 0 && from === '') return null;
    }
    const got =
      from === ''
        ? names(['ls-tree', '-r', '-z', '--name-only', localOid])
        : names(['diff', '--name-only', '-z', '--no-renames', from, localOid]);
    if (got === null) return null;
    for (const f of got) files.add(f);
  }
  return { kind: 'files', files: [...files] };
}
