import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localTestDirectory } from './local-test-directory.ts';

export type TestProcessResult = { status: number | null; signal?: string | null; error?: Error | undefined };

/** 只留测试报告与必要执行身份，不存环境、stdin 源码快照或生产数据。 */
export function createTestReport(root: string, args: string[], phase: string) {
  const directory = localTestDirectory(root, 'local-vitest-');
  const metadata: {
    version: number;
    phase: string;
    args: string[];
    startedAt: string;
    endedAt?: string;
    source?: { kind: string; digest: string; files: number };
    sourceAfter?: { digest: string; files: number };
    commands: {
      kind: string;
      command: string;
      args: string[];
      scriptSha256?: string;
      startedAt: string;
      endedAt?: string;
      status: number | null;
      signal?: string | null;
      errorCode?: string;
    }[];
    reports: Record<string, 'valid' | 'missing' | 'invalid'>;
    result?: { status: number | null; signal?: string | null; error: boolean };
  } = { version: 1, phase, args, startedAt: new Date().toISOString(), commands: [], reports: {} };
  const save = () => writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2));
  save();
  console.log(`测试报告保留：${directory}`);
  return {
    directory,
    metadata,
    save,
    path: (name: string) => join(directory, name),
    command<T extends TestProcessResult>(
      kind: string,
      command: string,
      argv: string[],
      run: () => T,
      scriptSha256?: string,
    ): T {
      const entry: (typeof metadata.commands)[number] = {
        kind,
        command,
        args: argv,
        startedAt: new Date().toISOString(),
        status: null,
        ...(scriptSha256 ? { scriptSha256 } : {}),
      };
      metadata.commands.push(entry);
      save();
      const result = run();
      entry.endedAt = new Date().toISOString();
      entry.status = result.status;
      entry.signal = result.signal ?? null;
      if (result.error) entry.errorCode = (result.error as NodeJS.ErrnoException).code ?? result.error.name;
      save();
      return result;
    },
    read(name: string, file: string) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        metadata.reports[name] = 'missing';
        save();
        throw new Error(`未获得完整 ${name} 测试报告：报告不存在或读不到`);
      }
      try {
        const report = JSON.parse(text);
        if (!report || !Array.isArray(report.testResults)) throw new Error('invalid');
        metadata.reports[name] = 'valid';
        save();
        return report;
      } catch {
        metadata.reports[name] = 'invalid';
        save();
        throw new Error(`未获得完整 ${name} 测试报告：不是合法 JSON 或没有 testResults`);
      }
    },
    finish(result: TestProcessResult) {
      metadata.endedAt = new Date().toISOString();
      metadata.result = { status: result.status, signal: result.signal ?? null, error: !!result.error };
      save();
    },
  };
}
