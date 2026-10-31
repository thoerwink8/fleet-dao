# packages/harness-web：新驾驶舱（重写第 5 片）

决定 0124 的新驾驶舱（母单 #3770，第 5 片 #3781）：新外壳、会话工作台（只读）、会话事件的实时流，整体挂在 `/next/` 下。旧驾驶舱 `packages/web` 一行不动，两边并行，换到根路径是第 10 片的事。

技术栈和旧驾驶舱一致（React 19、Vite、Tailwind 4 令牌），但这里不用 React Router 的框架模式，只用路由库（`createBrowserRouter`，`basename` 取 Vite 的 `base`＝`/next/`）。

## 入口

- `src/main.tsx`：路由表。五块一级信息架构（会话、任务、决策、法国运维、设置，见 `specs/3752-cockpit-rewrite/讨论稿.md`）都在导航里，这一片只有会话块有内容，其余四块是写明「哪一片做」的占位页。
- `src/components/shell.tsx`：外壳。侧栏 208px（收起 64px，记在 localStorage），768px 以下换底部四格标签栏，顶栏 `PageBar` 56px，间距 4px。
- `src/pages/workbench.tsx`：会话工作台。桌面左列会话列表、右边事件流；手机两个画面（`/` 列表，`/s/<号>` 事件流，左上角返回）。
- `src/components/session-stream.tsx`、`event-card.tsx`：事件流和每种事件的展示（会话轮次、派工请求、叫停、工人起止、进度、交结果、交回核验，不认识的类型落到折叠的原始内容，不丢）。
- `src/lib/feed.ts`：`SessionFeed`，实时流的全部逻辑，见下面「实时流怎么保证」。
- `src/app.css`：设计令牌（页底 `#f0f3fa`、品牌色 `#2962ff`、1px 发丝线、白卡片、正常态不上绿）。
- `dev/`：本机开发用的整套后端，**不是部署形态**。`dev/stack.ts` = PGlite 跑 fleet2 真迁移 + 真 `harness-api` + 一个很薄的开发后端；`dev/seed.ts` 灌样例事件；`dev/serve.ts` 是一条命令的入口。

## 本机跑起来看

两个终端：

```
pnpm --filter @fleet-dao/harness-web dev        # 开发后端 127.0.0.1:8790：PGlite（内存）+ 样例事件 + harness-api
pnpm --filter @fleet-dao/harness-web dev:web    # Vite 5180，/next/api 代理到 8790
```

打开 `http://localhost:5180/next/`。开发后端的终端里还能敲命令：`emit <会话号> <类型> <JSON载荷>` 往会话写一条事件（页面实时出现）；`api stop` / `api start` 只停、起接口层，看「已断开、自动重连、补齐」。`HARNESS_WEB_DATA_DIR` 给了就把 PGlite 存到那个目录（默认内存，退出即没）。

前端怎么连：浏览器只访问同源的 `/next/api/...`，**浏览器里没有令牌**。开发后端按会话号替浏览器向 harness-api 带上 `X-Fleet-Session-Token`（接口层只认请求头或 cookie，网址里带令牌一律 400）。开发后端还负责列会话（接口层按令牌只认一个会话，没有「列全部」）。

## 实时流怎么保证（旧坑 G4、E5）

- 首屏：先 `GET /sessions/<号>/history`（最新一页 200 条，升序，带 `head` 和 `hasMore`），再开 SSE，`Last-Event-ID` = `head`。「加载更早的」用 `before=<最老事件号>` 翻页。
- 不漏：断线重连带已收到的最大事件号（`Last-Event-ID`），服务端补发其后的全部；落后超过重放上限服务端发 `resync`，前端清掉已有的、**抖动等待后**整页重取最新一页。
- 不重：所有事件经 `mergeEvents`（`src/lib/merge.ts`）按事件号去重、升序，这是唯一一道关。
- 不风暴：不用浏览器自带的 `EventSource`（重连间隔固定、没有抖动、读不到状态码），自己用 fetch 读流。重连等待＝抖动退避（`src/lib/backoff.ts`：失败次数翻倍的上限、封顶 30 秒，等待在 `[250ms, 上限]` 里均匀随机），多个标签页同时断线不会同一刻撞回去；连上又很快被断的不算稳（5 秒才清零失败计数）；45 秒没收到任何字节（含 15 秒一次的心跳）当它死了重连。
- 重试没用的错（401、403、404、400）不重连，页面直接写原因。
- 会话列表轮询（`useSessions`）：10 秒一次，后端读失败间隔翻倍、封顶 60 秒，成功一次立刻回 10 秒（旧坑 E5）；页面不可见时不读。

## 测试

- 单测：`npx vitest run packages/harness-web`（`src/lib/*.test.ts`：去重合并、退避、SSE 解析、`SessionFeed` 的断线续传 / resync / 致命错 / 往上翻，用假 fetch 和假 sleep）。接口层的历史页在 `packages/harness-api/test/api.test.ts`。
- e2e：`pnpm --filter @fleet-dao/harness-web e2e`（先打包一次，不需要真 Postgres，用 PGlite；要本机装了 Chrome，或设 `E2E_BROWSER_CHANNEL`）。1440×900 和 390×844 两个项目各走一遍；每个用例自己一套后端，断后端＝停掉 harness-api，库里的事件号是真相，页面渲染出来的 `data-event-id` 必须和它一模一样。覆盖 G1（窄屏不横滚、关键控件在屏内）、G3（刚打开就点）、G4（断后端、续传、resync、多标签页同时断线再连不漏不重不风暴）、E5（列表轮询退避）。文件名 `*.e2e.ts`，不在仓库 vitest 的收录范围里。
- 截图：`pnpm --filter @fleet-dao/harness-web build && node packages/harness-web/e2e/shots.ts <标签>`，1440 和 390 各几个画面（列表、会话、异常、断开、占位页）存到仓根 `_tmp/shots/<标签>/`；挂进 PR 的做法见 `docs/design/驾驶舱界面.md` 第七部分（图不进代码分支）。

## 常见坑

- 前端走 Vite 打包，相对导入不带 `.ts`；`dev/`、`e2e/` 是 Node 直接跑的，相对导入要带 `.ts`。
- 接口层的 SSE 响应要先写一行注释（`: connected`）响应头才会真的送出去，否则带 `Last-Event-ID` 续传又没有新事件时，经过代理的客户端要等到第一次心跳才知道「连上了」。
- 参考工作台是私有仓，它的截图、名字、业务内容不进这个仓的文件、提交、PR、单。

## 改它时要连带改

- 事件类型的展示（`src/components/event-card.tsx`、`src/lib/describe.ts`）跟 `packages/harness-contract/src/index.ts` 的 `EVENT_TYPES` 走：加了类型先让它落到「其他」不丢，再给像样的展示。
- 接口层的 `GET /sessions/<号>/history` 在 `packages/harness-api/src/server.ts`（`handleHistory`），前端的取法在 `src/lib/api.ts`、`feed.ts`，两边一起改。
- 部署到 `/next/`（香港静态、法国接口）这一片没做：现在的 `dev/stack.ts` 只给开发和 e2e 用，部署要的「列会话、按登录身份代带令牌」怎么接另见后续单。
