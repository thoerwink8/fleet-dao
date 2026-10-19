import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failedFilesFromJson, type Step, type StepRun, withRetry } from './check.ts';
import { localTestDirectory } from './local-test-directory.ts';
import { runLocalVitest } from './local-vitest.ts';

/** 原重试政策不变；Windows 首轮/重试各留原始报告，其它平台保留原临时清理合同。 */
export function vitestAllStep(
  root: string,
  platform = process.platform,
  spawn: (args: string[], phase: string) => StepRun = (args, phase) =>
    runLocalVitest(root, args, process.env, platform, phase),
): Step {
  return {
    name: '测试（全量 vitest run）',
    run() {
      const dir =
        platform === 'win32'
          ? localTestDirectory(root, 'fleet-check-')
          : mkdtempSync(join(tmpdir(), 'fleet-check-'));
      const json = join(dir, 'result.json');
      if (platform === 'win32') console.log(`首轮/重试报告保留：${dir}`);
      try {
        return withRetry({
          run: () =>
            spawn(['run', '--reporter=default', '--reporter=json', `--outputFile.json=${json}`], 'first'),
          failedFiles: () => {
            try {
              return failedFilesFromJson(readFileSync(json, 'utf8'), root);
            } catch (e) {
              return `读不到结果文件（${e instanceof Error ? e.message : String(e)}）`;
            }
          },
          rerun: (files) =>
            spawn(
              platform === 'win32'
                ? [
                    'run',
                    ...files,
                    '--reporter=default',
                    '--reporter=json',
                    `--outputFile.json=${join(dir, 'retry.json')}`,
                  ]
                : ['run', ...files],
              'retry',
            ),
          out: (line) => console.log(line),
        });
      } finally {
        if (platform !== 'win32') rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
