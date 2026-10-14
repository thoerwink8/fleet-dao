import { describe, expect, it } from 'vitest';
import { FAILURE_TAIL_CHARS, runChildOk } from './child.ts';

describe('runChildOk 失败时的报错', () => {
  it('带上标准输出和 stderr 的尾部（go test 把挂了哪条写在标准输出末尾），过长只留最后一段', () => {
    const script =
      'process.stdout.write("head-".repeat(2000) + "\\n--- FAIL: TestSomething\\n"); process.stderr.write("err-tail"); process.exit(3)';
    let message = '';
    try {
      runChildOk(process.execPath, ['-e', script]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('退出码 3');
    expect(message).toContain('--- FAIL: TestSomething');
    expect(message).toContain('err-tail');
    expect(message.length).toBeLessThan(FAILURE_TAIL_CHARS + 400);
  });
});
