// 驾驶舱接口约定（web-api）：头部常量和通用形状（错误体、分页、操作人）。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { Cursor, Id } from './internal.ts';

export const WEB_API_PREFIX = '/api';
export const AUTH_PREFIX = '/auth';
export const CSRF_HEADER = 'X-CSRF-Token';

// —— 通用 ——

/** 所有非 2xx 的返回体。code 给程序判断，message 是给人看的白话。 */
export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/** 翻页：游标是后端给的不透明字符串，原样带回来即可。 */
export const PageQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** 谁做的：人（驾驶舱用户）、AI 帅位、引擎、会话里的 AI、服务器上的运维脚本。 */
export const ActorSchema = z.object({
  kind: z.enum(['user', 'ai', 'engine', 'agent', 'ops']),
  id: Id,
  name: z.string().optional(),
});
