import { expect, it, vi } from 'vitest';
import { policySourceOrigin } from '../../src/real/policy-source-origin.ts';

const credentialUrl = new URL('https://a.test');
credentialUrl.username = 'user';
credentialUrl.password = 'test-only';

it('复用systemd parser，仅返回唯一origin，不执行变量/命令，也不导入其它配置', () => {
  const before = process.env.FLEET_TEST_OTHER_SECRET;
  const read = vi.fn(
    () =>
      '# FLEET_PUBLIC_URL=https://ignored.test\nFLEET_TEST_OTHER_SECRET=private\n FLEET_PUBLIC_URL = "https://cockpit.example.test"\n',
  );
  expect(policySourceOrigin(read)).toBe('https://cockpit.example.test');
  expect(read).toHaveBeenCalledOnce();
  expect(process.env.FLEET_TEST_OTHER_SECRET).toBe(before);
});

it.each([
  '',
  'FLEET_PUBLIC_URL',
  'FLEET_PUBLIC_URL=\n',
  'FLEET_PUBLIC_URL=https://a.test\nFLEET_PUBLIC_URL=https://a.test\n',
  'FLEET_PUBLIC_URL="https://a.test\n',
  'FLEET_PUBLIC_URL=https://a.test\\',
  'FLEET_PUBLIC_URL=http://private.test\n',
  'FLEET_PUBLIC_URL=https://a.test/path\n',
  `FLEET_PUBLIC_URL=${credentialUrl.href}\n`,
  'FLEET_PUBLIC_URL=https://a.test:444\n',
  'FLEET_PUBLIC_URL=$(private)\n',
])('缺失/重复/格式/非法origin明确失败且不泄露原文 %#', (env) => {
  let error: unknown;
  try {
    policySourceOrigin(() => env);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    'CI 策略 source origin 未确认：api.env 的 FLEET_PUBLIC_URL 必须唯一且为规范 HTTPS origin',
  );
});

it('读取失败不打印底层错误中的配置内容', () => {
  expect(() =>
    policySourceOrigin(() => {
      throw new Error('private-secret');
    }),
  ).toThrow('CI 策略 source origin 未确认');
  try {
    policySourceOrigin(() => {
      throw new Error('private-secret');
    });
  } catch (err) {
    expect(String(err)).not.toContain('private-secret');
    expect((err as Error).cause).toBeUndefined();
  }
});
