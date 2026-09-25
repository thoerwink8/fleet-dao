// 可见范围的白话：正式驾驶舱发链接的页面、演示版的提示都用这一份。
import type { DemoDetail, DemoModule } from './scope';

export const MODULE_LABEL: Record<DemoModule, { label: string; hint?: string }> = {
  board: { label: '看板', hint: '含总览' },
  task: { label: '任务详情', hint: '含任务清单' },
  dispatch: { label: '调度台' },
  channels: { label: '渠道与账号' },
  quota: { label: '额度' },
  schedules: { label: '定时任务' },
  notifications: { label: '通知' },
  audit: { label: '操作记录' },
  settings: { label: '设置' },
};

export const DETAIL_LABEL: Record<DemoDetail, { label: string; hint: string }> = {
  status: { label: '只看状态和耗时', hint: '需求、子任务的标题换成编号（需求 #12、子任务 B）' },
  titles: { label: '能看任务标题', hint: '原话、要改的文件、步骤和过程照样收起' },
  process: { label: '能看步骤清单和过程', hint: '全都能看' },
};
