// 测试共用：假后端（不出网）、内存库（PGlite，不连真库）。
import type { BackendRequest, BackendResult, JevBackend } from '../src/backend.ts';

export const MODEL = 'jev-1.13.0';

export interface FakeBackend extends JevBackend {
  calls: BackendRequest[];
}

/** 假后端：按 reply 回；默认每道题都答第一个选项、把握 0.9。 */
export function fakeBackend(
  reply?: (req: BackendRequest) => BackendResult | Promise<BackendResult>,
  model = MODEL,
): FakeBackend {
  const calls: BackendRequest[] = [];
  return {
    kind: 'fake',
    model,
    calls,
    async ask(req) {
      calls.push(req);
      if (reply) return reply(req);
      return ok(Object.fromEntries(req.questions.map((q) => [q.id, [q.options[0]?.id ?? '', 0.9]])));
    },
  };
}

/** 一次成功的回包：题号 → [选项, 把握度]。 */
export function ok(
  answers: Record<string, [string, number]>,
  extra: Partial<Extract<BackendResult, { ok: true }>> = {},
): BackendResult {
  return {
    ok: true,
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, [option, confidence]]) => [id, { option, confidence }]),
    ),
    model: MODEL,
    latencyMs: 12,
    inputTokens: 400,
    tokensEstimated: false,
    ...extra,
  };
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
