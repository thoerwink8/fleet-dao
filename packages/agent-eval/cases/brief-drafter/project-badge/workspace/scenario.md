# 要写成任务书的需求

创始人原话（2026-10-08 21:40）：「驾驶舱项目页上，没连上的项目现在是一片空白，我看不出是没连上还是没数据。没连上的显示一个灰色的「未连接」徽章。」

背景：
- 驾驶舱的项目页在 `packages/web/src/pages/projects.tsx`，每一行的状态列现在对「没连上」的项目什么都不渲染。
- 徽章组件在 `packages/web/src/components/status-badge.tsx`，已有绿色「在线」、红色「失败」两种。
- 页面的测试在 `packages/web/test/projects.test.tsx`，徽章组件的测试在 `packages/web/test/status-badge.test.tsx`。

只改这个页面和徽章组件，不动接口。
