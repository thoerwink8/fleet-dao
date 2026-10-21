import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #3413：GitHub 公开 check 注解能证明的等待点。Actions 日志本机 HTTP 403，帧不在注解里。
// 不替换 worker-replacement-3413/ 里已有的 protobuf / describe。两次注解也不是同一个失败。
const directory = fileURLToPath(new URL('./replay/worker-replacement-3413/', import.meta.url));
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const text = (name: string) => readFileSync(`${directory}${name}`, 'utf8');
const linesOf = (name: string) => text(name).split('\n');

const ORIGINAL_MESSAGE_SHA256 = '9c5810a0553bd31d7cf66cfb67961b1c1275463fac8fbd6242614368b95246a0';
const ORIGINAL_SOURCE_SHA256 = '54b6b49cd629d7eda937a23e6bc7113272b7cc4279eaa5a67e920951eb6a891d';
const BRIEF_MESSAGE_SHA256 = 'a9ba5ebf40165402c41f23fa02c4a0f90be80d2f20cd8a594c840d176d9d307c';
const BRIEF_SOURCE_SHA256 = 'c754d8617fc51f8dab4d6e4e84507f23e0dc001987cb34b9f51045aa5f952543';
const SIBLING_MESSAGE_SHA256 = 'e6ea5a86f5fbf67964927e4f593f2fca145ba4528269defb2f8945eda5a28f8a';
const WATCHDOG_RUN = '6385a827-f825-4d12-8bd9-d3e2351b6db6';
const SLOW_RUN = 'd8500003-6fa1-44b5-8530-cb27b667ff2b';

function statusAfter(message: string): {
  phase: string;
  doing: string;
  round: number;
  closedIssueClose: { token: unknown };
} {
  const marker = '最后一次状态：';
  const start = message.indexOf(marker);
  const end = message.indexOf('\n', start);
  return JSON.parse(message.slice(start + marker.length, end)) as {
    phase: string;
    doing: string;
    round: number;
    closedIssueClose: { token: unknown };
  };
}

const WORKER_REPLACEMENT_TITLE =
  'packages/engine/test/push-handback.test.ts > permission push handback original park protocol > same run reconstructs business receipts after worker replacement, then accepts one new request';
type CheckRun = {
  job: number;
  run: number;
  name: string;
  headSha: string;
  conclusion: string;
  annotation: { path: string; startLine: number; title: string; messageFile: string; messageSha256: string };
};

describe('#3413 公开 CI 注解里的等待点', () => {
  it('check-run 元数据把每则注解绑到 run、job、head 和用例标题，正文字节对得上', () => {
    // 注解正文里没有用例名，用例名只在 API 的 title；job 名和 head 只在 check-run。
    const runs = JSON.parse(text('ci-check-runs.json')) as CheckRun[];
    expect(
      runs.map(({ job, run, name, headSha, conclusion, annotation: a }) => [
        job,
        run,
        name,
        headSha,
        conclusion,
        a.path,
        a.startLine,
        a.title === WORKER_REPLACEMENT_TITLE,
      ]),
    ).toEqual([
      [
        118528847472,
        39392992046,
        'test (6/8)',
        'd45207791e21faa6c7c166f5023b49fe18f21264',
        'failure',
        'packages/engine/test/push-handback.test.ts',
        289,
        true,
      ],
      [
        118528847602,
        39392992046,
        'test (8/8 · temporal)',
        'd45207791e21faa6c7c166f5023b49fe18f21264',
        'failure',
        'packages/engine/test/push-handback-contract.test.ts',
        233,
        false,
      ],
      [
        119181973185,
        39588087499,
        'test (5/8)',
        '6c4d389277f98a807e3ebc219aa58d06c0046db3',
        'failure',
        'packages/engine/test/support.ts',
        181,
        true,
      ],
    ]);
    for (const { job, annotation } of runs) {
      expect(annotation.messageFile).toBe(`ci-job-${job}.annotation.txt`);
      expect(sha256(text(annotation.messageFile))).toBe(annotation.messageSha256);
    }
    expect(runs.map((r) => r.annotation.messageSha256)).toEqual([
      ORIGINAL_MESSAGE_SHA256,
      SIBLING_MESSAGE_SHA256,
      BRIEF_MESSAGE_SHA256,
    ]);
  });

  it('原 run 39392992046 只指到 it 行：没有 pollQuery、phase、workflow 或 run', () => {
    const message = text('ci-job-118528847472.annotation.txt');
    expect(sha256(message)).toBe(ORIGINAL_MESSAGE_SHA256);
    expect(message).toContain('Test timed out in 60000ms.');
    expect(message).toContain('packages/engine/test/push-handback.test.ts:289:3');
    expect(message).not.toContain('permission push park');
    expect(message).not.toContain('pollQuery');
    expect(message).not.toContain('phase');
    expect(message).not.toContain('FLEET_SYNTHETIC_HISTORY');
    expect(message).not.toContain(WATCHDOG_RUN);
    expect(message).not.toContain(SLOW_RUN);
    const source = text('push-handback.d45207791e21.txt');
    expect(sha256(source)).toBe(ORIGINAL_SOURCE_SHA256);
    const lines = linesOf('push-handback.d45207791e21.txt');
    // 注解列 289、列 3 是 it 本身。305 行的 await parked 在注解里没有出现。
    expect(lines[288]?.slice(2, 4)).toBe('it');
    expect(lines[288]).toContain(
      'same run reconstructs business receipts after worker replacement, then accepts one new request',
    );
    expect(lines[304]).toBe('        r = request(await parked(h));');
    expect(message).not.toContain(':305:');
  });

  it('run 39588087499 停在第一个工人的 await parked，查询有回包，phase 仍是 brief，注解没有 run', () => {
    const message = text('ci-job-119181973185.annotation.txt');
    expect(sha256(message)).toBe(BRIEF_MESSAGE_SHA256);
    expect(message).toContain('等了 20000 毫秒还没等到：permission push park');
    expect(message).toContain('packages/engine/test/support.ts:181:11');
    expect(message).toContain('packages/engine/test/push-handback.test.ts:343:21');
    expect(message).not.toContain('FLEET_SYNTHETIC_HISTORY');
    expect(message).not.toContain('60000ms');
    expect(message).not.toContain(WATCHDOG_RUN);
    expect(message).not.toContain(SLOW_RUN);
    const status = statusAfter(message);
    expect(status).toMatchObject({ phase: 'brief', doing: '读单子和需求文档', round: 1 });
    expect(status.closedIssueClose.token).toBeNull();
    const source = text('push-handback.6c4d389277f9.txt');
    expect(sha256(source)).toBe(BRIEF_SOURCE_SHA256);
    const lines = linesOf('push-handback.6c4d389277f9.txt');
    expect(lines[341]).toBe("        diagnostics.mark('wait:first-worker:parked-query');");
    expect(lines[342]).toBe('        r = request(await parked(h));');
    expect(lines[342]?.slice(20, 25)).toBe('await');
    // 同一份测试字节也留下过本机 slow-parked-query，但那是另一个 run，最后活动在 selfCheck。
    const slow = JSON.parse(text('slow-parked-query.identity.capture')) as {
      testSha256: string;
      runId: string;
      stage: string;
    };
    expect(slow).toMatchObject({
      testSha256: BRIEF_SOURCE_SHA256,
      runId: SLOW_RUN,
      stage: 'wait:first-worker:parked-query',
    });
    const watchdog = JSON.parse(text('identity.capture')) as {
      runId: string;
      stage: string;
      workflowId: string;
    };
    expect(watchdog).toMatchObject({
      runId: WATCHDOG_RUN,
      stage: 'first-worker:parked-query',
      workflowId: 'handback-0c8f4322-17be-4b14-9e92-c81f0514e949',
    });
  });

  it('同一次原 CI 的 temporal 台是另一份合同测试的 it 行，不能当成 worker replacement', () => {
    const message = text('ci-job-118528847602.annotation.txt');
    expect(sha256(message)).toBe(SIBLING_MESSAGE_SHA256);
    expect(message).toContain('Test timed out in 60000ms.');
    expect(message).toContain('packages/engine/test/push-handback-contract.test.ts:233:3');
    expect(message).not.toContain('push-handback.test.ts');
    expect(message).not.toContain('park-kind');
    expect(message).not.toContain(WATCHDOG_RUN);
    expect(text('contract-d45207791e21-line233.txt').trim()).toBe(
      "it('wrong H0 and exhausted original budget cannot wake or grant a new observation', async () => {",
    );
  });
});
