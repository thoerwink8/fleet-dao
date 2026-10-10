# 要写成任务书的需求

创始人原话（2026-10-08 22:05）：「任务列表接口要能按状态筛选，筛完要有截图给我看。」

背景：
- 接口在 `packages/api/src/routes/tasks.ts`，现在 `GET /tasks` 返回全部任务，没有筛选参数。
- 驾驶舱的任务页在 `packages/web/src/pages/tasks.tsx`，它调用这个接口，但这一单不改页面。
- 接口的测试在 `packages/api/test/tasks-route.test.ts`。
- 状态有四种：`queued`、`running`、`failed`、`done`。

这一单只做接口这一半（页面那半以后另开单）。
