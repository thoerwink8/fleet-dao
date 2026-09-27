// 任务简报（Brief）：Lead 派给副手的一块活（docs/decisions/0003-fusion-flow.md 第 5 条）。
// 缺目标、范围、只许改的文件、怎么算合格、交回格式的不收；几份同时派的不许改到同一个文件（最多 3 份）。
import { z } from 'zod';

const text = z.string().trim().min(1);

export const BriefSchema = z.object({
  /** 这块要做成什么。 */
  goal: text,
  /** 做到哪为止、不碰什么。 */
  scope: text,
  /** 约束：禁令、接口、不许用的写法……没有就给空数组。 */
  constraints: z.array(text),
  /** 只许改的文件；以 / 结尾的是目录，下面的都算。 */
  files: z.array(text).min(1),
  /** 怎么算合格，逐条。 */
  acceptance: z.array(text).min(1),
  /** 交回什么：改了哪些文件、测试结果、没做完的。 */
  returnFormat: text,
});

export type Brief = z.infer<typeof BriefSchema>;

export type BriefCheck = { ok: true; brief: Brief } | { ok: false; problems: string[] };

/** 一张单里同时派的副手最多几个（0003 第 5 条）。 */
export const MAX_PARALLEL_SIDEKICKS = 3;

const FIELD_NAMES: Record<string, string> = {
  goal: '目标',
  scope: '范围',
  constraints: '约束',
  files: '只许改的文件',
  acceptance: '怎么算合格',
  returnFormat: '交回格式',
};

/** 仓里的相对路径：不许绝对路径、盘符、反斜杠、..、./ 开头。 */
function pathProblem(p: string): string | undefined {
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return `「${p}」是绝对路径，要写仓里的相对路径`;
  if (p.includes('\\')) return `「${p}」用了反斜杠，路径一律用 /`;
  if (p.startsWith('./')) return `「${p}」不要以 ./ 开头`;
  if (p.split('/').some((seg) => seg === '..')) return `「${p}」带 ..，不许跳出仓`;
  if (p.includes('//')) return `「${p}」里有空的一段`;
  return undefined;
}

export function checkBrief(input: unknown): BriefCheck {
  const parsed = BriefSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const field = String(issue.path[0] ?? '');
      const name = FIELD_NAMES[field];
      return name ? `缺「${name}」或写得不对` : `简报认不出：${issue.message}`;
    });
    return { ok: false, problems: [...new Set(problems)] };
  }
  const brief = parsed.data;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of brief.files) {
    const bad = pathProblem(f);
    if (bad) problems.push(bad);
    if (seen.has(f)) problems.push(`「${f}」写了两遍`);
    seen.add(f);
  }
  return problems.length ? { ok: false, problems } : { ok: true, brief };
}

/** a 和 b 会不会改到同一处：一样，或者一个是另一个的上级目录。 */
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}

/** 几份简报能不能同时派：最多 3 份，两两之间不许改到同一个文件。 */
export function checkParallel(briefs: readonly Brief[]): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (briefs.length > MAX_PARALLEL_SIDEKICKS) {
    problems.push(`同时派了 ${briefs.length} 份，一张单最多 ${MAX_PARALLEL_SIDEKICKS} 个副手同时干`);
  }
  for (let i = 0; i < briefs.length; i++) {
    for (let j = i + 1; j < briefs.length; j++) {
      for (const a of briefs[i]?.files ?? []) {
        for (const b of briefs[j]?.files ?? []) {
          if (overlaps(a, b))
            problems.push(`第 ${i + 1} 份和第 ${j + 1} 份都要改「${a === b ? a : `${a}」和「${b}`}」`);
        }
      }
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

/** 改了简报外的哪些文件（要动别人的文件，副手得先回报 Lead 改派）。 */
export function outsideBrief(brief: Brief, changed: readonly string[]): string[] {
  const allowedBy = (allowed: string, file: string) =>
    allowed === file || (allowed.endsWith('/') && file.startsWith(allowed));
  return changed.filter((file) => !brief.files.some((allowed) => allowedBy(allowed, file)));
}
