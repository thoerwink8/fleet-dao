// 驾驶舱接口约定（web-api）：内部共用件（Id、Time、Cursor、Same）：只在 web-api/ 目录内共用，不经入口导出。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';

export const Id = z.string().min(1).max(200);
export const Time = z.iso.datetime({ offset: true });
export const Cursor = z.string().min(1).max(500);

export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
