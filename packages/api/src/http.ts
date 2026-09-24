// 请求解析、返回校验与统一的错误格式（shared/web-api.ts 的 ApiErrorBody）。
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { Logger } from './ports.ts';

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: unknown;
  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export function errorHandler(log: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) {
        log.error(err.message, { code: err.code, path: c.req.path, details: JSON.stringify(err.details) });
      }
      return c.json(errorBody(err.code, err.message, err.details), err.status);
    }
    if (err instanceof HTTPException) {
      return c.json(errorBody(`http_${err.status}`, err.message || '请求被拒'), err.status);
    }
    log.error('未处理的错误', { method: c.req.method, path: c.req.path, error: String(err.stack ?? err) });
    return c.json(errorBody('internal', '后端出错了，已记日志'), 500);
  };
}

export const notFound: NotFoundHandler = (c) => c.json(errorBody('not_found', '没有这个接口'), 404);

export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json', '请求体不是合法的 JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'invalid_request', '请求内容不符合约定', parsed.error.issues);
  return parsed.data;
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(400, 'invalid_query', '查询参数不符合约定', parsed.error.issues);
  return parsed.data;
}

/** 按约定的形状校验后再返回：多余字段（比如库里的邮箱）被剥掉，缺字段当场 500 而不是把坏数据交给前端。 */
export function reply<S extends z.ZodType>(
  c: Context,
  schema: S,
  data: z.input<S>,
  status: ContentfulStatusCode = 200,
): Response {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(500, 'bad_response_shape', '后端返回的数据不符合约定', parsed.error.issues);
  }
  return c.json(parsed.data as object, status);
}
