// 推送前的本机预检（.githooks/pre-push 调它）：把「CI 上一定会跑、判法又确定」的那几样在推之前跑一遍，红了当场修，
// 不用等几分钟 CI 回来才知道。创始人 2026-10-03：CI 慢的大头不是机器慢，是「红了、改、重推、再跑一遍」这个来回。
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

export interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** 起不来（找不到命令）时有值；和「命令跑了但失败」分开。 */
  error?: Error | undefined;
}

export interface PreparePushDeps {
  /** 这次改了哪些文件（仓内相对路径）。读不成抛，由调用方记「没查成」。 */
  changed: () => string[];
  repo: RepoView;
  graph: () => PackageGraph | string;
  /** 跑一条命令（cwd 是仓根），同步。 */
  run: (cmd: string, args: readonly string[]) => CmdResult;
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
