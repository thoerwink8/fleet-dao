// 驾驶舱接口约定（web-api）：头部常量和通用形状（错误体、分页、操作人）。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { Cursor, Id } from './internal.ts';

export const WEB_API_PREFIX = '/api';
export const AUTH_PREFIX = '/auth';
export const CSRF_HEADER = 'X-CSRF-Token';

/**
 * 飞书网关调 /api 的第二种进法（不用 Cookie、不用 CSRF）：`Authorization: Bearer <网关通行证>`，
 * 再用这个请求头写明代表哪位创始人（飞书 open_id）。后端按 open_id 认人，不是创始人就 403；操作记录写 via=feishu。
 */
export const FEISHU_ACTING_HEADER = 'X-Fleet-Acting-Feishu';

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

/** 谁做的：人（驾驶舱用户）、AI 帅位、引擎、会话里的 AI。 */
export const ActorSchema = z.object({
  kind: z.enum(['user', 'ai', 'engine', 'agent']),
  id: Id,
  name: z.string().optional(),
});
