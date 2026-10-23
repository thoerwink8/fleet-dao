import type { Reporter, TestModule, TestRunEndReason, TestSpecification, Vitest } from 'vitest/node';
import {
  configSnapshot,
  identity,
  MAX_PROJECTS,
  type ReporterEvidence,
  reporterRule,
  resourceSnapshot,
  safeVersion,
  UNKNOWN,
  writeEvidence,
} from './ci-runtime-evidence.ts';

/** 只观察本次 vitest run 主进程；end 是框架回执，不代表 CLI 最终成功。 */
export default class RuntimeEvidenceReporter implements Reporter {
  private snapshot: ReporterEvidence | undefined;
  private failed = false;

  private observe(fn: () => void) {
    try {
      fn();
    } catch {
      this.failed = true;
      console.error('CI_RUNTIME_EVIDENCE observation-failed');
    }
  }

  private save() {
    if (!this.snapshot) return;
    if (this.failed) this.snapshot.observation = 'observation-failed';
    const dir = process.env.FLEET_CI_EVIDENCE_DIR;
    if (!dir || !writeEvidence(dir, 'reporter.json', this.snapshot, reporterRule)) {
      this.snapshot.observation = 'write-failed';
      this.failed = true;
      console.error('CI_RUNTIME_EVIDENCE write-failed');
    }
  }

  onInit(ctx: Vitest) {
    this.observe(() => {
      this.snapshot = {
        schema: 1,
        writer: 'vitest-reporter',
        pid: process.pid,
        identity: identity(),
        node: safeVersion(process.version),
        vitest: safeVersion(ctx.version),
        phase: 'initialized',
        specificationCount: UNKNOWN,
        globalConfig: configSnapshot(ctx.config as unknown as Record<string, unknown>),
        projects: [],
        omittedProjects: 0,
        resources: resourceSnapshot(),
        startedAt: UNKNOWN,
        end: UNKNOWN,
        observation: 'ok',
      };
      this.save();
    });
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>) {
    this.observe(() => {
      if (!this.snapshot) return;
      const projects = new Set(specifications.map((spec) => spec.project));
      this.snapshot.projects = [...projects]
        .slice(0, MAX_PROJECTS)
        .map((project) => configSnapshot(project.config as unknown as Record<string, unknown>));
      this.snapshot.omittedProjects = Math.max(0, projects.size - MAX_PROJECTS);
      this.snapshot.phase = 'started';
      this.snapshot.specificationCount = specifications.length;
      this.snapshot.startedAt = new Date().toISOString();
      this.snapshot.resources = resourceSnapshot();
      this.save();
    });
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<unknown>, reason: TestRunEndReason) {
    this.observe(() => {
      if (!this.snapshot) return;
      this.snapshot.phase = 'ended';
      this.snapshot.end = {
        reason,
        moduleCount: modules.length,
        unhandledCount: errors.length,
        endedAt: new Date().toISOString(),
      };
      this.save();
    });
  }
}
