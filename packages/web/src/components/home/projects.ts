// 首页项目卡怎么排、四个数怎么写成一句（#2759）。
// 有问题的（卡住，或还有要这个仓拍的）排前面；同样有问题的，卡住多的在前。
// 本周上线、里程碑读不到写「没记」，不拿 0 顶。

import type { HomeProject } from './types';

/** 这张卡要不要排到前面：卡住了，或还有要拍的。 */
export function projectProblem(project: HomeProject): boolean {
  return project.stuck > 0 || project.decisions > 0;
}

/** 有问题的在前；卡住多的在前；其余按仓名。 */
export function sortProjects(projects: readonly HomeProject[]): HomeProject[] {
  return [...projects].sort((a, b) => {
    const problem = Number(projectProblem(b)) - Number(projectProblem(a));
    if (problem !== 0) return problem;
    if (a.stuck !== b.stuck) return b.stuck - a.stuck;
    if (a.decisions !== b.decisions) return b.decisions - a.decisions;
    return a.repo.localeCompare(b.repo, 'zh');
  });
}

/** 本周上线几版。null = 读不到。 */
export function shippedText(n: number | null): string {
  return n === null ? '没记' : `${n} 版`;
}

/** 当前里程碑进度。没排写「没有」，读不到写「没记」。 */
export function milestoneText(milestone: HomeProject['milestone']): string {
  if (milestone.state === 'none') return '没有';
  if (milestone.state === 'unread') return '没记';
  return `${milestone.title} ${milestone.done}/${milestone.total}`;
}
