# packages/harness-api：新内核的接口层

决定 0124 的新内核（母单 #3770）接口层：会话令牌、Streamable HTTP MCP、会话事件的 SSE。方案见 #3770 讨论稿「总设计」第 1–3 节；这一片是 #3775 的接口半。

## 不变量

- 只依赖 `harness-contract` 和 `harness-store`，不依赖旧包。
- 令牌只存 sha256 哈希（`fleet2.session_tokens`），一个令牌只绑一个会话、一个角色（`commander` / `worker`）；核验按哈希找行再定时长比较，撤销了或不存在一律 401，不区分。令牌只走请求头 `X-Fleet-Session-Token` 或 cookie `fleet_session_token`，网址里出现名字带 `token` 的参数一律 400。
- MCP 工具逐请求按令牌角色注册：角色不够的工具不在列表里、调了就是「没这个工具」；工具参数里没有会话号，写和读都落在令牌绑的那个会话的流 `session:<号>`。影子模式下 `externalWrite` 的工具（`spawn_worker`、`stop_worker`）不注册。`spawn_worker` 六项必填，缺了在 zod 层拒。
- 这一片的处理器只往 `fleet2.events` 追加事件，不做任何外部动作；真正的派工、停工由后面的片接。
- SSE 的事件号就是 `events.id`：带 `Last-Event-ID` 只补更新的；落后超过重放上限（默认 1000）发 `resync` 不补发，看不懂的号也发 `resync`。读都分页（`PAGE_MAX`），行数和页大小成正比。每个轮询周期重新核验令牌，撤销后最晚一个周期连接被关。

## 驾驶舱口（`src/cockpit.ts`、`src/bin/cockpit.ts`，#3818）

新驾驶舱（`packages/harness-web`，公网 `/next/`）只读读会话的口，和令牌口是两个进程里的两个服务，共用 `session-http.ts` 里的历史页和 SSE 实现（各传各的「还准不准看」函数）。

- 身份：浏览器带旧驾驶舱签的登录 Cookie `__Host-fleet_session`。格式从 `packages/api/src/tokens.ts`（`signPayload`/`verifyPayload`）和 `session.ts`（`SessionClaims`、purpose `fleet-session/v1`）拷来，不 import 旧包（决定 0124）；密钥是环境变量 `FLEET_SESSION_SECRET`（和旧后端同一把）。旧格式变了这里要跟着改。
- 固定向量（`test/cockpit.test.ts` 第一条守着）：密钥 `test-secret-0123456789abcdef-test`，声明 `{"uid":"00000000-0000-4000-8000-000000000001","sid":"sid-fixed-0001","iat":1700000000,"exp":1700001000,"m":"password","v":3}`（键按这个顺序），签出 `eyJ1aWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJzaWQiOiJzaWQtZml4ZWQtMDAwMSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAxMDAwLCJtIjoicGFzc3dvcmQiLCJ2IjozfQ.SYQh9-AG4-IRnvv19uvj3TUD8TLOVeO1acgwfqwrI58`。这条是拿旧包的 `signPayload` 生成的。
- 每个请求：签名对、没过期、uid 是 uuid，再按主键查 `public.users`：active 且 role=founder（否则 403），`v`（缺省 0）等于 `session_version`（否则 401）。开着的 SSE 每个周期重核一次。
- 只有三条 GET（加上面的过程流两条，共五条）：`/next/api/sessions?limit&before`（投影 `stream_heads`，读时顺手 `advanceStreamHeads`）、`/next/api/sessions/<号>/history`、`/next/api/sessions/<号>/events`。会话令牌（请求头、cookie）和 Authorization 一概不认，带了就 401；没有 `/mcp`；网址带 token 400；会话号不合格 404；不回 CORS 头；`keepAliveTimeout` 6 分钟（比香港 nginx 的 5 分钟长）。
- 工人过程（#3781）：另有两条 GET `/next/api/transcripts/<runId>/history` 和 `/events`，读流 `transcript:<runId>`（工人每一步落的事件，见 harness-workers），和会话流共用 `serveHistory` / `serveSse`（传流名）。身份、会话号合格检查、404 都和会话路径一样。历史页是游标分页（`before` 往老翻、`after` 往新翻、`limit` 默认 200 封顶 `PAGE_MAX`），读的行数 ≤ limit+1；过程流的页另有字节上限 `TRANSCRIPT_PAGE_BYTES`（256KB 载荷：每条最多约 4KB，200 条会有几百 KB），超了少给几条（至少一条）并把 `hasMore` 置真，往老翻留最新的、往新翻留最早的，游标接得上（做法参考 T3 Code 历史页的行数加字节双上限）。这条流不进会话列表（列表只列 `session:%`）。
- 会话列表每项带 `tail`（#3781 第二轮）：该会话最近 `TAIL_EVENTS`（24）条事件的瘦身版，最旧在前，只摘 `outcome`、`verdict`、`final`、`status`、`exitCode`、`killed`、`spawnError`、`deadline`，不带大文本；驾驶舱据此判工人状态。读法是对本页每个会话走 `events_stream_id_idx` 倒着取 24 条（`cross join lateral`），行数 ≤ 页大小 × 24，和流多长无关。判读规则在 `packages/harness-contract/src/worker-state.ts`（前端和这里共用一份）；要加判状态用的新字段，改 `loadTails` 的 `jsonb_build_object` 和那份规则。
- 会话列表响应另带 `stuckCount`（#3781 收尾）：全库「卡住」的会话数，不受 `limit`、`before` 影响，用同一份 `deriveWorkerState` 判（`countStuck`）。读法是对所有会话流各取近期 24 条事件，读的行数 ≤ 会话数 × 24；会话数涨到几千要改成增量（投影里存状态）。
- 环境变量：`FLEET2_DATABASE_URL`、`FLEET_SESSION_SECRET`、`FLEET2_COCKPIT_HOST`（默认 127.0.0.1）、`FLEET2_COCKPIT_PORT`（默认 7346）、`FLEET2_COCKPIT_COOKIE_NAME`（只有本机 http 的 e2e 才改）。这个库用户要能读 `public.users` 的 `id, role, active, session_version`。

## 测试

- `npx vitest run packages/harness-api`：PGlite 跑 fleet2 真迁移（`@fleet-dao/harness-store/testing`），起真的 HTTP 服务，用 MCP SDK 客户端和 fetch 流式读 SSE。对应旧坑 SEC2、SEC3、G4。
- 改了 `packages/harness-store/src/schema.ts` 要重新生成迁移，见 harness-store 的 AGENTS.md。
