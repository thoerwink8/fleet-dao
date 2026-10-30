// 账本来源枚举（#3741 片 2c）：进程内写账本用了 engine、api 两个来源，枚举要认；认不出的仍然拒绝。
import { describe, expect, it } from 'vitest';
import { INTAKE_SOURCE_KINDS, IntakeSourceSchema } from '../src/intake.ts';

describe('IntakeSourceSchema', () => {
  it('认 engine 和 api，原有的四个不丢', () => {
    for (const kind of ['local-session', 'harness-commander', 'harness-chat', 'mirasim', 'engine', 'api']) {
      expect(IntakeSourceSchema.safeParse({ kind, ref: 'x' }).success).toBe(true);
    }
    expect([...INTAKE_SOURCE_KINDS]).toEqual([
      'local-session',
      'harness-commander',
      'harness-chat',
      'mirasim',
      'engine',
      'api',
    ]);
  });

  it('【故意造出的失败】不认识的来源、多余字段都拒绝', () => {
    expect(IntakeSourceSchema.safeParse({ kind: 'cron', ref: 'x' }).success).toBe(false);
    expect(IntakeSourceSchema.safeParse({ kind: 'api', ref: 'x', extra: 1 }).success).toBe(false);
  });
});
