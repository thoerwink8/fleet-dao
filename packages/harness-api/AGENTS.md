# packages/harness-api：新内核的接口层

决定 0124 的新内核（母单 #3770）接口层：会话令牌、Streamable HTTP MCP、会话事件的 SSE。方案见 #3770 讨论稿「总设计」第 1–3 节；这一片是 #3775 的接口半。

## 不变量

- 只依赖 `harness-contract` 和 `harness-store`，不依赖旧包。
- 令牌只存 sha256 哈希（`fleet2.session_tokens`），一个令牌只绑一个会话、一个角色（`commander` / `worker`）；核验按哈希找行再定时长比较，撤销了或不存在一律 401，不区分。令牌只走请求头 `X-Fleet-Session-Token` 或 cookie `fleet_session_token`，网址里出现名字带 `token` 的参数一律 400。
- MCP 工具逐请求按令牌角色注册：角色不够的工具不在列表里、调了就是「没这个工具」；工具参数里没有会话号，写和读都落在令牌绑的那个会话的流 `session:<号>`。影子模式下 `externalWrite` 的工具（`spawn_worker`、`stop_worker`）不注册。`spawn_worker` 六项必填，缺了在 zod 层拒。
- 这一片的处理器只往 `fleet2.events` 追加事件，不做任何外部动作；真正的派工、停工由后面的片接。
- SSE 的事件号就是 `events.id`：带 `Last-Event-ID` 只补更新的；落后超过重放上限（默认 1000）发 `resync` 不补发，看不懂的号也发 `resync`。读都分页（`PAGE_MAX`），行数和页大小成正比。每个轮询周期重新核验令牌，撤销后最晚一个周期连接被关。

## 测试

- `npx vitest run packages/harness-api`：PGlite 跑 fleet2 真迁移（`@fleet-dao/harness-store/testing`），起真的 HTTP 服务，用 MCP SDK 客户端和 fetch 流式读 SSE。对应旧坑 SEC2、SEC3、G4。
- 改了 `packages/harness-store/src/schema.ts` 要重新生成迁移，见 harness-store 的 AGENTS.md。
