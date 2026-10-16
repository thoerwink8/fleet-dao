// 改标准路径清单：主线上文件不在＝这个仓没声明，当空清单；在却认不出照抛，不当成没碰到。
// 任务工作流（real/task-activities）、每小时对账读文件（real/hourly-reconcile）、自动合并兜底（jobs/auto-merge-check）
// 都走这一份，不再各写一种「文件不在」的读法。

import { parseStandardPaths, type StandardPath } from '@fleet-dao/conventions';

/**
 * text 为 null 表示主线上没有这个文件（空清单）。
 * 认不出抛错，原文在错误里；调用方要改成自己的错类就接住再抛。
 */
export function standardPathsList(text: string | null): StandardPath[] {
  if (text === null) return [];
  const parsed = parseStandardPaths(text);
  if (typeof parsed === 'string') throw new Error(`改标准路径清单认不出：${parsed}`);
  return parsed;
}
