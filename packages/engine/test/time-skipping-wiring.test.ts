// 防止另一个创建入口重新绕回SDK隐式下载；生命周期本身由真实工作流用例验。
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('evolution 统一走受管 createEnv，业务测试仅一处调用 SDK createTimeSkipping', () => {
  const support = readFileSync(new URL('./support.ts', import.meta.url), 'utf8');
  const evolution = readFileSync(new URL('./evolution.test.ts', import.meta.url), 'utf8');
  expect(support).toContain('path: requireTestServer()');
  expect(support).toContain("type: 'existing-path'");
  expect(evolution).toContain('env = await createEnv()');
  expect(evolution).not.toContain('TestWorkflowEnvironment.createTimeSkipping(');
  expect(evolution).toContain('await env?.teardown()');
});
