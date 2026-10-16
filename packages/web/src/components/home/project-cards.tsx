// 首页按项目出卡（#2759）：一个仓一块。本周上线几版、在跑几张、卡住几张、当前里程碑。
// 有问题的排前面。区块并排，里面只有行，不再套一层卡片（界面规范：最多两层容器）。
import { cn } from '../../lib/utils';
import { Section, SectionGrid } from '../layout/section';
import { inkClass, type LayoutTone } from '../layout/tone';
import { milestoneText, projectProblem, shippedText, sortProjects } from './projects';
import type { HomeProject } from './types';

function Fact({ label, value, tone }: { label: string; value: string; tone?: LayoutTone }) {
  return (
    <div className="min-w-0">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className={cn('num mt-0.5 truncate text-body font-medium', tone && inkClass[tone])}>{value}</dd>
    </div>
  );
}

function ProjectCard({ project }: { project: HomeProject }) {
  const problem = projectProblem(project);
  const tone: LayoutTone | undefined =
    project.stuck > 0 ? 'fail' : project.decisions > 0 ? 'human' : undefined;
  return (
    <Section
      data-project={project.repo}
      data-problem={problem ? 'yes' : 'no'}
      title={project.repo}
      {...(tone ? { tone } : {})}
    >
      <dl className="grid grid-cols-2 gap-3">
        <Fact label="本周上线" value={shippedText(project.shippedThisWeek)} />
        <Fact label="在跑" value={`${project.running} 张`} />
        <Fact
          label="卡住"
          value={`${project.stuck} 张`}
          {...(project.stuck > 0 ? { tone: 'fail' as const } : {})}
        />
        <Fact label="里程碑" value={milestoneText(project.milestone)} />
      </dl>
    </Section>
  );
}

/** 每个仓一张。没给这一块（老后端）写明没给，不画成「还没有项目」。 */
export function ProjectCards({ projects }: { projects: readonly HomeProject[] | undefined }) {
  if (projects === undefined) {
    return (
      <Section title="项目" data-project-cards="missing">
        <p className="text-body text-muted-foreground">项目这一块没给</p>
      </Section>
    );
  }
  if (projects.length === 0) {
    return (
      <Section title="项目" data-project-cards="empty">
        <p className="text-body text-muted-foreground">还没有项目</p>
      </Section>
    );
  }
  const sorted = sortProjects(projects);
  return (
    <div data-project-cards>
      <SectionGrid cols={2}>
        {sorted.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </SectionGrid>
    </div>
  );
}
