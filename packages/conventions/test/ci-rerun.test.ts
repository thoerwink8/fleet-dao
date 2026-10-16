// 主线 ci 红了自动重跑一次失败的 job（.github/workflows/ci-rerun.yml，#2747）：把工作流读出来核。
// 重跑等于「再给一次机会」，写错了要么死循环重跑（一直占并发槽、真红永远在跑），要么重跑 PR、每夜的轮次、要么令牌给大了；
// 所以每条约束都有一条故意造出的失败：把那一处改坏，判定器必须点名。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEXT = readFileSync(join(ROOT, '.github/workflows/ci-rerun.yml'), 'utf8');
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: unknown;
  jobs?: Record<string, { if?: string; permissions?: unknown; steps?: Step[] }>;
}

/** 这份工作流哪里不对（空数组 = 对）。 */
function problems(text: string): string[] {
  const doc = parse(text) as Workflow;
  const out: string[] = [];
  const on = doc.on ?? {};
  if (Object.keys(on).join(',') !== 'workflow_run') out.push('触发只能是 workflow_run');
  const wr = (on.workflow_run ?? {}) as { workflows?: unknown; types?: unknown; branches?: unknown };
  if (JSON.stringify(wr.workflows) !== '["ci"]') out.push('只认 ci 这一个工作流');
  if (JSON.stringify(wr.types) !== '["completed"]') out.push('只在跑完时触发');
  if (JSON.stringify(wr.branches) !== '["main"]') out.push('只认主线');
  if (JSON.stringify(doc.permissions) !== '{"actions":"write"}') out.push('权限只给 actions: write');
  const jobs = Object.values(doc.jobs ?? {});
  if (jobs.length !== 1) out.push('只有一个 job');
  const job = jobs[0];
  if (job?.permissions !== undefined) out.push('job 上不许另给权限');
  const cond = (job?.if ?? '').replace(/\s+/g, ' ');
  for (const [need, why] of [
    ["github.event.workflow_run.name == 'ci'", '只认 ci'],
    ["github.event.workflow_run.event == 'push'", '只认主线 push 那一轮'],
    ["github.event.workflow_run.head_branch == 'main'", '只认主线分支'],
    ["github.event.workflow_run.conclusion == 'failure'", '只在红了时重跑'],
    ['github.event.workflow_run.run_attempt == 1', '只在第一次运行时重跑（防死循环）'],
  ] as const) {
    if (!cond.includes(need)) out.push(why);
  }
  if (/\|\|/.test(cond)) out.push('条件里不许有 ||（任何一条放宽都可能重跑别的轮次）');
  const steps = job?.steps ?? [];
  if (steps.some((s) => s.uses?.startsWith('actions/checkout'))) out.push('不检出代码');
  const runs = steps.filter((s) => s.run !== undefined);
  const rerun = runs.filter((s) => /gh run rerun /.test(s.run ?? ''));
  if (rerun.length !== 1) out.push('恰好一处 gh run rerun');
  const r = rerun[0];
  if (r && !/gh run rerun "\$RUN_ID" --failed\b/.test(r.run ?? '')) out.push('只重跑失败的 job（--failed）');
  if (r && r.env?.RUN_ID !== '${{ github.event.workflow_run.id }}') out.push('重跑的是触发它的那一轮');
  if (runs.some((s) => (s.run ?? '').includes('${{'))) out.push('表达式经环境变量给，不插进脚本');
  return out;
}

describe('ci-rerun.yml：主线 ci 第一次运行红了，重跑失败的 job 一次', () => {
  it('仓里这份没毛病', () => {
    expect(problems(TEXT)).toEqual([]);
  });

  it('【故意造出的失败】去掉 run_attempt == 1（重跑那次再红又会重跑，死循环）：点名', () => {
    const bad = TEXT.replace(/ &&\n\s+github\.event\.workflow_run\.run_attempt == 1/, '');
    expect(bad).not.toBe(TEXT);
    expect(problems(bad)).toContain('只在第一次运行时重跑（防死循环）');
  });

  it('【故意造出的失败】不只认 ci（多认一个工作流）、不只认 push、红了以外也重跑、没限主线：点名', () => {
    const more = TEXT.replace('workflows: [ci]', 'workflows: [ci, release]');
    expect(problems(more)).toContain('只认 ci 这一个工作流');
    const anyEvent = TEXT.replace("github.event.workflow_run.event == 'push' &&", '');
    expect(problems(anyEvent)).toContain('只认主线 push 那一轮');
    const anyResult = TEXT.replace(
      "github.event.workflow_run.conclusion == 'failure'",
      "github.event.workflow_run.conclusion != 'success'",
    );
    expect(problems(anyResult)).toContain('只在红了时重跑');
    const loose = TEXT.replace(
      'github.event.workflow_run.run_attempt == 1',
      "(github.event.workflow_run.run_attempt == 1 || github.event.workflow_run.event == 'schedule')",
    );
    expect(problems(loose)).toContain('条件里不许有 ||（任何一条放宽都可能重跑别的轮次）');
    const noBranch = TEXT.replace('    branches: [main]\n', '');
    expect(problems(noBranch)).toContain('只认主线');
  });

  it('【故意造出的失败】权限给多了（加 contents: write）、job 上另给权限：点名', () => {
    const wide = TEXT.replace(
      'permissions:\n  actions: write',
      'permissions:\n  actions: write\n  contents: write',
    );
    expect(wide).not.toBe(TEXT);
    expect(problems(wide)).toContain('权限只给 actions: write');
    const jobPerm = TEXT.replace(
      '    runs-on: ubuntu-latest',
      '    permissions: write-all\n    runs-on: ubuntu-latest',
    );
    expect(problems(jobPerm)).toContain('job 上不许另给权限');
  });

  it('【故意造出的失败】重跑整轮（没带 --failed）、重跑的不是触发它的那一轮：点名', () => {
    const all = TEXT.replace('--failed', '');
    expect(problems(all)).toContain('只重跑失败的 job（--failed）');
    const other = TEXT.replace('RUN_ID: ${{ github.event.workflow_run.id }}', 'RUN_ID: ${{ github.run_id }}');
    expect(problems(other)).toContain('重跑的是触发它的那一轮');
  });

  it('ci.yml 的 e2e 报告 artifact 名带 run_attempt：重跑那次名字不撞、传得上去', () => {
    const doc = parse(CI) as { jobs: { e2e: { steps: { uses?: string; with?: { name?: string } }[] } } };
    const upload = doc.jobs.e2e.steps.filter((s) => s.uses?.startsWith('actions/upload-artifact'));
    expect(upload).toHaveLength(1);
    expect(upload[0]?.with?.name).toBe(
      'e2e-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.shard }}',
    );
    // 偶发统计按 e2e-* 下载，新名字照样认得
    const flaky = readFileSync(join(ROOT, '.github/workflows/e2e-flaky.yml'), 'utf8');
    expect(flaky).toContain("-p 'e2e-*'");
  });
});
