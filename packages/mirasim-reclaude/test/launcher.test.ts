import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('真实编译执行切换、权限、强杀收尾及失败路径测试', { timeout: 120_000 }, () => {
  const output = execFileSync('go', ['test', '-count=1', '.'], {
    cwd: fileURLToPath(new URL('../launcher/', import.meta.url)),
    encoding: 'utf8',
    timeout: 110_000,
    windowsHide: true,
  });
  expect(output).toMatch(/\bok\s+reclaude-mirasim\b/);
});
