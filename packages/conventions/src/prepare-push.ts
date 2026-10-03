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
}

export function preparePush(deps: PreparePushDeps): PreparePushResult {
  let changed: string[];
  try {
    changed = deps.changed();
  } catch (e) {
    return { code: 2, lines: [`推送前预检没查成：${e instanceof Error ? e.message : String(e)}`] };
  }
  const plan = planCi({ event: 'pull_request', changed, graph: deps.graph() });
  const steps: Step[] = [];
  if (plan.biome) steps.push({ name: 'biome 格式检查', cmd: 'biome', args: ['check', '.'] });
  if (plan.tsc === 'all' || plan.tsc.length > 0) {
    steps.push({
      name: 'tsc 类型检查',
      cmd: 'tsc',
      args: plan.tsc === 'all' ? ['-b'] : ['-b', ...plan.tsc],
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
    if (r.status !== 0) {
      const tail = `${r.stdout}${r.stderr}`.trim().split('\n').slice(-40).join('\n');
      return { code: 1, lines: [...lines, `${step.name} 没过（退出码 ${r.status}）：`, tail] };
    }
    lines.push(`${step.name} 过了`);
  }
  return { code: 0, lines };
}
