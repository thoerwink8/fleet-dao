# packages/harness-web：新驾驶舱（重写第 5 片）

决定 0124 的新驾驶舱（母单 #3770，第 5 片 #3781）：新外壳、会话工作台（只读）、会话事件的实时流，整体挂在 `/next/` 下。旧驾驶舱 `packages/web` 一行不动，两边并行，换到根路径是第 10 片的事。

技术栈和旧驾驶舱一致（React 19、Vite、Tailwind 4 令牌），但这里不用 React Router 的框架模式，只用路由库（`createBrowserRouter`，`basename` 取 Vite 的 `base`＝`/next/`）。

## 入口

- `src/main.tsx`：路由表。五块一级信息架构（会话、任务、决策、法国运维、设置，见 `specs/3752-cockpit-rewrite/讨论稿.md`）都在导航里，这一片只有会话块有内容，其余四块是写明「哪一片做」的占位页。
- `src/components/shell.tsx`：外壳。侧栏 208px（收起 64px，记在 localStorage），768px 以下换底部四格标签栏，顶栏 `PageBar` 56px，间距 4px。
- `src/pages/workbench.tsx`：会话工作台。桌面左列会话列表、右边事件流；手机两个画面（`/` 列表，`/s/<号>` 事件流，左上角返回）。
- `src/components/session-stream.tsx`、`event-card.tsx`：事件流和每种事件的展示（会话轮次、派工请求、叫停、工人起止、进度、交结果、交回核验，不认识的类型落到折叠的原始内容，不丢）。
- 第二轮（#3781）：长输出和工具调用折叠、列表按状态排序。
  - 契约里没有单独的“工具调用”事件，这里的“工具调用”＝接口层 MCP 工具落成的四种事件（`worker.spawn.requested`、`worker.stop.requested`、`worker.progress.reported`、`worker.result.submitted`，对应 `spawn_worker`、`stop_worker`、`report_progress`、`submit_result`）。连续 3 条起折叠成一行「调了 N 次工具：report_progress×5…」（`src/lib/tool-runs.ts`），收起时卡片仍在页面里（`hidden`），事件号对账和展开都不重新取。
  - 长输出（证据、错误输出末尾，还有轮次文字、任务和进度摘要）默认只显示前 200 字或 12 行，先到为准，可展开（`src/lib/clamp.ts`、`src/components/clamped.tsx`）。
  - 列表按工人状态分四组：卡住或失败 > 在跑 > 空闲或等待 > 做完，组内按最后事件号倒序，卡住的置顶并带数量（`src/lib/session-state.ts` 的 `deriveWorkerState`，纯函数，规则写在它的注释里，单测 `src/lib/round2.test.ts`）。状态读的是列表接口给的 `tail`（最近 24 条事件的瘦身版）。分组只对已加载的会话排，没点「加载更多」时更老的卡住会话不在里面（数量带「+」不会骗人，已加载多少数多少）。
- 收尾（#3781）：
  - 界面上露出的原始枚举值（事件类型、任务结果、交回结局、核验结论、会话模式、任务状态）显示中文，映射只在 `src/lib/labels.ts` 一处（`typeLabel`、`outcomeLabel`、`verdictLabel` 等，返回 `{text, raw}`），原值放元素的 `title` 里方便排查；不认识的值照原样显示，不丢。契约里加了新的类型或结局，先在这里补中文名。
  - 「做完」组默认折叠，组头显示条数、点开展开；折叠状态存 `localStorage`（键 `fleet.next.sessions.done-collapsed`，读写包 try/catch，读不到就当折叠，`src/lib/collapse.ts`）。折叠时不渲染会话行，所以 e2e 里要点做完组里的会话先 `expandDone(page)`。
  - 顶栏「卡住 N」用接口给的 `stuckCount`（全库数，翻页不影响），前端不再自己数；旧接口没给时不显示。组头里的数字仍是已加载会话里该组的个数。窄屏这条顶栏本来就收起。
  - 判状态的规则（`deriveWorkerState` 等）搬到 `packages/harness-contract/src/worker-state.ts`（子路径 `@fleet-dao/harness-contract/worker-state`，不带 zod），这里的 `session-state.ts` 只留分组、排序和中文组名，从那边转出。
- 第三轮（#3781）：工人会话详情。工人会话号是 `worker-<runId>`（派工器给工人令牌绑的会话号），页面据此再开一条过程流（`useTranscriptFeed` → `SessionFeed` 的 `kind: 'transcripts'`，读 `/next/api/transcripts/<runId>/…`），和会话流里的进度、交结果按事件号（全库单调，不同流直接比）串成一条时间线（`src/lib/transcript.ts` 的 `buildSteps`、`buildTimeline`，纯函数，单测在 `transcript.test.ts`）。
  - 助手的话是正文（`SayRow`，不套卡片）；一次工具调用一行（`ToolRow`：图标、工具名、参数摘要、出错或运行中标记），点开看参数和结果，结果和参数沿用 200 字或 12 行预览（`OutputBlock`）；调用和结果按 `toolUseId` 配对，结果没来的显示「运行中」。
  - 连续 3 次起的工具调用折叠成一行摘要「调了 N 个工具：Read×3、Bash×5 · 1 个出错」（`ToolRunRow`，出错的边框变红、收起时每一步仍在页面里 `hidden`）；和上面 MCP 事件的折叠互不混。
  - 指挥会话里的派工请求和交回核验带「看工人的完整过程」链接（`workerSessionOf`）：交回取载荷里的 `runId`；派工请求按派工器的编号规则 `d<派工请求事件号>-a1` 推（`packages/harness-dispatch/src/dispatcher.ts`，改了编号规则这里要跟着改）。
  - 过程可能很长：首屏最新一页，「加载更早的事件」同时往前翻会话流和过程流。
  - 样例：`dev/seed.ts` 的 `worker-d12-a1`（26 步，穿插进度和交结果），`cmd-demo-login-fix` 的交回带 `runId: d12-a1` 链过去。
- `src/lib/feed.ts`：`SessionFeed`，实时流的全部逻辑，见下面「实时流怎么保证」。
- `src/app.css`：设计令牌（页底 `#f0f3fa`、品牌色 `#2962ff`、1px 发丝线、白卡片、正常态不上绿）。
- `dev/`：本机开发和 e2e 用的整套后端。`dev/stack.ts` = PGlite 跑 fleet2 真迁移（外加最小的 `public.users`，放一位创始人）+ **真的驾驶舱口**（`harness-api` 的 `createCockpitApi`，部署用的就是这份代码）+ 一个只转发 `/next/api/*`、放 `dist/` 的前门（相当于香港 nginx）；`dev/seed.ts` 灌样例事件；`dev/serve.ts` 是一条命令的入口。前门不带任何凭据、不认识会话令牌。

## 本机跑起来看

两个终端：

```
pnpm --filter @fleet-dao/harness-web dev        # 开发后端 127.0.0.1:8790：PGlite（内存）+ 样例事件 + harness-api
pnpm --filter @fleet-dao/harness-web dev:web    # Vite 5180，/next/api 代理到 8790
```

先打开 `http://localhost:5180/next/dev-login`（拿一个测试登录 Cookie，跳回 `/next/`）。开发后端的终端里还能敲命令：`emit <会话号> <类型> <JSON载荷>` 往会话写一条事件（页面实时出现）；`api stop` / `api start` 只停、起接口层，看「已断开、自动重连、补齐」。`HARNESS_WEB_DATA_DIR` 给了就把 PGlite 存到那个目录（默认内存，退出即没）。

前端怎么连：浏览器只访问同源的 `/next/api/...`，**浏览器里没有会话令牌，也不存不转**。带的是旧驾驶舱签发的登录 Cookie（线上名 `__Host-fleet_session`，本机 http 用不带前缀的 `fleet_session`），由驾驶舱口自己验（签名、`public.users` 里在用的创始人、`session_version`）；列会话、历史页、SSE 三条只读 GET，见 `packages/harness-api/AGENTS.md`「驾驶舱口」。e2e 用测试密钥签一个 Cookie 塞进浏览器（`stack.cookie()`），部署形态和 e2e 走同一份驾驶舱口代码。
没登录（401）时会话列表和会话页给登录入口：「用飞书登录」（`/auth/feishu/login?next=%2Fnext%2F`，服务端 302 回新驾驶舱）和「账密登录」（`/login`，旧驾驶舱的登录页），都是整页跳转。

## 实时流怎么保证（旧坑 G4、E5）

- 首屏：先 `GET /sessions/<号>/history`（最新一页 200 条，升序，带 `head` 和 `hasMore`），再开 SSE，`Last-Event-ID` = `head`。「加载更早的」用 `before=<最老事件号>` 翻页。
- 不漏：断线重连带已收到的最大事件号（`Last-Event-ID`），服务端补发其后的全部；落后超过重放上限服务端发 `resync`，前端清掉已有的、**抖动等待后**整页重取最新一页。
- 不重：所有事件经 `mergeEvents`（`src/lib/merge.ts`）按事件号去重、升序，这是唯一一道关。
- 不风暴：不用浏览器自带的 `EventSource`（重连间隔固定、没有抖动、读不到状态码），自己用 fetch 读流。重连等待＝抖动退避（`src/lib/backoff.ts`：失败次数翻倍的上限、封顶 30 秒，等待在 `[250ms, 上限]` 里均匀随机），多个标签页同时断线不会同一刻撞回去；连上又很快被断的不算稳（5 秒才清零失败计数）；45 秒没收到任何字节（含 15 秒一次的心跳）当它死了重连。
- 重试没用的错（401、403、404、400）不重连，页面直接写原因。
- 会话列表轮询（`useSessions`）：10 秒一次读最新一页，后端读失败间隔翻倍、封顶 60 秒，成功一次立刻回 10 秒（旧坑 E5）；页面不可见时不读；401 停下来给登录入口。「加载更多」用接口返回的 `nextBefore` 往更老翻，见过的会话按号去重、按最后事件号倒序，被新会话顶下去的不会消失。
- 后台标签页释放（`src/lib/visibility.ts`）：香港 443 不开 http2，浏览器对同一域名最多 6 条连接、所有标签页共用。页面隐藏满 10 秒就 `feed.stop()`（保留游标），回到前台 `start()`，带 `Last-Event-ID` 续，补不全走 resync。不做多标签页共用一条流（Web Locks 加 BroadcastChannel），理由见 #3818 设计。

## 测试

- 单测：`npx vitest run packages/harness-web`（`src/lib/*.test.ts`：去重合并、退避、SSE 解析、`SessionFeed` 的断线续传 / resync / 致命错 / 往上翻，用假 fetch 和假 sleep）。接口层的历史页在 `packages/harness-api/test/api.test.ts`。
- e2e：`pnpm --filter @fleet-dao/harness-web e2e`（先打包一次，不需要真 Postgres，用 PGlite；要本机装了 Chrome，或设 `E2E_BROWSER_CHANNEL`）。1440×900 和 390×844 两个项目各走一遍；每个用例自己一套后端，断后端＝停掉 harness-api，库里的事件号是真相，页面渲染出来的 `data-event-id` 必须和它一模一样。覆盖 G1（窄屏不横滚、关键控件在屏内）、G3（刚打开就点）、G4（断后端、续传、resync、多标签页同时断线再连不漏不重不风暴）、E5（列表轮询退避），以及 #3818：8 个标签页隐藏 7 个、10 秒后开着的 SSE 不超过 1 条，隐藏的回到前台续上不漏不重（桌面跑；无头浏览器里各页都算可见，用改 `visibilityState` 加发 `visibilitychange` 模拟后台）、401 登录入口、退出后流断开、列表「加载更多」、`dist/` 里没有令牌头名。文件名 `*.e2e.ts`，不在仓库 vitest 的收录范围里。
- 工人会话详情 e2e：`e2e/specs/transcript.e2e.ts`（26 步的样例：折叠和展开、长输出预览、跳转、实时、翻页、窄屏不横滚；页面事件号和库一致）。
- 截图：`pnpm --filter @fleet-dao/harness-web build && node packages/harness-web/e2e/shots.ts <标签>`，1440 和 390 各几个画面（列表、会话、异常、断开、占位页）存到仓根 `_tmp/shots/<标签>/`；挂进 PR 的做法见 `docs/design/驾驶舱界面.md` 第七部分（图不进代码分支）。

## 常见坑

- 前端走 Vite 打包，相对导入不带 `.ts`；`dev/`、`e2e/` 是 Node 直接跑的，相对导入要带 `.ts`。
- 接口层的 SSE 响应要先写一行注释（`: connected`）响应头才会真的送出去，否则带 `Last-Event-ID` 续传又没有新事件时，经过代理的客户端要等到第一次心跳才知道「连上了」。
- 参考工作台是私有仓，它的截图、名字、业务内容不进这个仓的文件、提交、PR、单。

## 改它时要连带改

- 事件类型的展示（`src/components/event-card.tsx`、`src/lib/describe.ts`）跟 `packages/harness-contract/src/index.ts` 的 `EVENT_TYPES` 走：加了类型先让它落到「其他」不丢，再给像样的展示。
- 接口层的历史页和 SSE 在 `packages/harness-api/src/session-http.ts`（`serveHistory`、`serveSse`），会话列表在 `src/cockpit.ts`（`listSessions`），前端的取法在 `src/lib/api.ts`、`feed.ts`、`hooks.ts`，两边一起改。
- 部署到 `/next/`（法国驾驶舱口 service、香港 nginx、发版带上 `dist/`）是 #3818 的后几片，这一片没做；`dev/stack.ts` 只给开发和 e2e 用。
