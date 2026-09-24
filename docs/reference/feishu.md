# 飞书集成手册

> **实现 `packages/feishu`（香港飞书网关、确认卡、三类推送与关注、置顶盘面卡、菜单、回复即追问）和飞书端到端自测之前读。** 对应设计 §三 第 7、25 条，§十五 15.3–15.4，§十六「飞书群分诊机器人」一行。
> 讲清旧机器人的架构与实际使用数据、四个毛病（吵、慢、乱、听不懂）的成因、§15.4 要用的飞书接口与硬限制、开发时必须实测的点、端到端自测怎么做；坑逐条写成测试用例。
> 来源：旧系统审计切片 s6（2026-09-25）。基线：windsurf-dao `b1ebd88d`；ai-gateway-stack `origin/master` `db44877`；VPS 只读读回于 2026-09-25 01:18–01:45（只取聚合数字，不取消息正文、群编号、身份编号）；飞书开放平台文档取自官方 `.md` 版本（链接见附录 B）。全仓记法见 [README](README.md)。
> 占位：`<团队群>` `<测试群>` `<总控群>` `<项目群A>`；全文不含密钥、令牌、应用编号、群编号、人名、邮箱、IP；凭据只写种类不写位置。
> 标记：【实咬】有 issue/判例/提交为证；【代码】读代码得出、没见实咬记录；【读回】服务器只读取数；【文档】飞书官方文档；【推断】由前几类推出、未直接验证。

---

## 〇、先看结论

1. **旧机器人实际上已经没人用了**【读回】：项目群走完「判重→三问→建单」的一共只有 1 次（接线当晚的 windsurf-dao#813，4 条消息、48 分钟，含现场排障）；总控群/私聊问答记录共 6 条（2026-09-04～06），之后为 0；总控群累计发出 148 张待拍板卡，对应 84 件事，按钮点击落账 5 次（全是「按推荐执行」），138 张是机器自己改成「别处已处理」。
2. **太吵的根**：把「待拍板」这种状态做成了消息流；机器向人求助的速率失控（5 天 27 张待拍板只有 4 张真要拍）；按时间去重（6 小时一到同一件事再发一张，最多一件发了 20 张）；往群里发消息的出口有 8 个以上、各自决定，专门做的播报闸测绿了却从没接到生产。
3. **慢或没反应的根**：没有即时回执（人格规则明文「不说『收到』」）；一条消息要串行等 2–3 次大模型调用、每次预算 180 秒，全进程一条串行队列；几次「哑了」都没人报警——模型被下线哑一整天、按钮回调没订阅、修好的代码没进活进程；检查只看「进程活着」「模型在」，没有一道量「发一句、多久回」。
4. **乱的根**：群建了又建（话题群→普通群→播报群），旧群删不掉、机器人退不出；卡片两套版式（1.0/2.0）、卡片被拒就降级成纯文本墙；菜单按「群输入框」设计，但官方文档写明机器人菜单只在单聊，菜单事件也不带群编号，旧代码取不到就回落发到总控群。
5. **听不懂的根**：每个需求固定三问、至少两轮；答过的又被问（状态快照、网页端回复另开话题）；在总控群/私聊提需求被回「这里是总控群，需求请发到项目群」；黑话直译；上下文只有这段对话，盘面数据源现在是空的。
6. **§15.4 要按飞书硬限制修几处**（第四节 4.4）：群里不 @ 机器人，回复卡片它收不到（除非开敏感权限）；卡片发出 14 天后不能再更新，置顶盘面卡要定期重发；长连接是「集群模式」，新旧两个进程连同一个应用会随机分走事件；「收到」建议用表情回复，不多发一条消息。
7. **端到端自测**：用户身份发消息、回复、读回都有开放接口；**点卡片按钮、点菜单没有开放接口**，只能浏览器自动化驱动飞书网页版——这是最大的实测风险（第五、六节）。

---

## 一、旧机器人架构

### 1.1 一张图

```
飞书 ──WebSocket 长连接（官方 node-sdk 的 WSClient + EventDispatcher）──> feishu-triage.service
     订阅：im.message.receive_v1 / card.action.trigger / application.bot.menu_v6        （Node 单进程，systemd）
       │ normalizeInbound → 全进程串行队列 → triage 状态机（块 B）→ 大模型（网关 grok-4.6，流式，180 秒）
       │ 回话：im.v1.message.reply（纯文本，回到话题根消息）
       │ 发卡：im.v1.message.create（interactive）；改卡：im.v1.message.patch
       └ 写 GitHub：子进程跑 issue-gateway（帅位机器人身份，群消息 id 当幂等键）

不经这个进程、各自往飞书发消息的出口：
  仓外脚本 hub-say；lark-cli 子进程（待拍板卡 hub-ask、sendToHub 纯文本、日报卡、看板播报、额度报警……）
```

### 1.2 事件怎么收（长连接，不是回调）

- 官方 SDK 长连接，服务器不开端口、不要公网回调（`scripts/feishu-triage.mjs:4-7, 697-708`；`docs/cli-notes/feishu.md:12,19`；上位决定 `docs/decisions/2026-08-31-groupchat-triage-dispatch.md`「渠道机制备忘」）。
- 注册三类：收消息、卡片回传、机器人菜单（`feishu-triage.mjs:699-707`）。卡片回传走同一条长连接，3 秒内把 toast/卡片回包还给 SDK（`:701-704`）。
- 归一化同时认两种结构：长连接推的扁平结构、webhook 的嵌套结构（`:142-144`，2026-09-03 只认后者时事件被全部静默丢弃）。
- 过滤：机器人自己发的（`sender_type === 'app'`）、非文本消息、空文本一律跳过；剥掉 `@_user_N` 占位（`:151-161`）。
- 普通消息与菜单进**一条全进程串行队列**（`:1296-1302`）；卡片回调单独走、不排队（`:1303-1306`）。
- 测试用 `--fixture <events.jsonl>` 文件事件源代替长连接，fixture 模式不加载 SDK（`:8-9, 1233-1268`）。
- SDK 惰性加载，服务器装在 `host/machine/feishu-triage/node_modules`；实机版本 node-sdk 1.73.1【读回】。

### 1.3 回话与发卡

- 回话只有纯文本，回复到话题根消息；机器人回复的消息 id 记进别名表（`feishu-triage.mjs:713-720, 1204-1212`）。
- 待拍板卡：Card JSON **1.0**，`config` 只有 `wide_screen_mode`（没声明 `update_multi`），标题「待拍板：仓#号」，正文出事/影响/推荐/期限等 7 行，三个按钮「按推荐执行（主）/等我回来拍/换个方案」，按钮 `value` 与 `behaviors.callback` 都带 `{issue, choice, repo}`（`scripts/lib/feishu-hub-card.mjs:1-3, 34-64, 66-113`）；拍板后换成绿色「已拍」卡（`:115-140`）。
- 日报卡：Card JSON **2.0**，一个头条数字 + 四列指标带变化量 + 两个按钮，`update_multi: true`（`scripts/lib/feishu-daily-card.mjs:170-278`）。
- 卡片被飞书拒收就降级成纯文本再发（`scripts/lib/feishu-card-text.mjs`；`scripts/lib/hub-ask.mjs:108-133`；`scripts/lib/broadcast-io.mjs:96-122`）。
- 送达只认飞书回的 `message_id`，退出码 0 不算（`hub-ask.mjs:5, 62-86`；提交 `29dfba6e2`）。

### 1.4 按钮回调怎么收

- `liveCardAction`：先算出 toast 立刻回包（「已收到选择，正在保存到 GitHub…」），GitHub 评论放到回包之后（`setImmediate`），写成功再 PATCH 卡片成「已拍」；同一件事保存中再点提示「上一项选择正在保存」（`feishu-triage.mjs:907-1031`）。
- 回包路径不查通讯录，名字只用事件里的（`:844-846`；提交 `a42e4d14c`）。
- 日报卡按钮只弹 toast，不改卡、不写 GitHub（`:850-861`；`feishu-daily-card.mjs:292-313`）。

### 1.5 菜单

- 事件 `application.bot.menu_v6`，`event_key = list_pending`（「看待拍板」），和对账同一条取数（GitHub「待拍板」标签为真相源），已有卡原地更新、没有的补发，再回一句「待拍板 N 件」；0 件明说、没查成明说（`scripts/lib/hub-pending.mjs:12-14, 248-306, 424-449`；`feishu-triage.mjs:1066-1135`）。

### 1.6 大脑（triage）

- 项目群：判重（`gh search` 前 10 条 + 大模型判「同一件事/相关/无关」）→ 三问（缺一必问，一轮最多 2 条）→ 大模型渲染正文 → 建单；放行两档：发起人在放行名单里直接「已消歧」，否则「待拍板」并往总控群发卡；建单后同话题新消息追评（`scripts/lib/feishu-triage-core.mjs:28-39, 127-227`）。
- 总控群/私聊（开关在 `docs/dispatch-policy.json` 的 `hubChat` 节）：待拍板话题里的回复直接落成拍板评论；短问「状态/看板」出确定性表格；问候走大模型短答；其余由大模型分类（判断题小模型在旁听，达标后才先答）：新需求→指路项目群、拍板→落评论、问盘面→读指挥官态势/健康表/熔断表后大模型作答（`feishu-triage-core.mjs:229-382`）。
- 大模型：网关 `/v1/chat/completions`，模型 `grok-4.6`，流式，预算 180 秒，带 `X-Dao-*` 溯源头（`feishu-triage.mjs:118-123, 454-569`）。
- 人格：`host/skills/feishu-triage/persona.md` 全文就是 system 段，十条规则 + 三问；第 3 条写明「不说『收到』『好的』」（`persona.md:10`）。每群可选 profile（人格/意图白名单/拒答口径，`scripts/lib/feishu-group-profile.mjs`）。

### 1.7 群怎么配

- 映射表形状：`{ "<群编号>": { "repo": "owner/name", "kind": "project" } | { "kind": "hub" }, 可选 profile }`，`_` 开头的键是注释（`feishu-triage.mjs:183-213`；`host/skills/feishu-ops/SKILL.md:10-22`）。
- 读哪份：`--groups` 参数 > 实机映射文件（放机器本地、不进 git）> 仓内占位 `host/machine/feishu-groups.json`（`feishu-triage.mjs:98-109`，windsurf-dao#1557）。
- 演变：windsurf-dao#801 定「3 个项目群 + 1 个总控群」，一律建成话题群 → 改建成普通群（`docs/cli-notes/feishu.md:16`）→ windsurf-dao#1029 再建「道·播报」；4 个旧话题群的编号写死在代码里准备退群（`scripts/lib/broadcast-digest.mjs:7-20`）。
- 实机现状【读回】：映射表 3 个项目群 + 2 个总控类群；机器人现在只在 4 个群里，映射表里有 1 个群它已不在；每群 profile 配了 0 个、播报订阅配了 0 个；`~/.dao/` 下还有一份旧映射（4 个老群，与现役 0 重合）和一份 `.bak`。
- 放行名单在凭据文件的 `allowOpenIds`，实机只有 1 人【读回】（新设计要两位创始人都在白名单）。
- 群有效性检查：dao-check ㉘ 用 `lark-cli im chats get --as bot` 逐个确认群还在（`scripts/lib/feishu-groups-check.mjs`）。

### 1.8 lark-cli 怎么用

- 装与授权：`npm i -g @larksuite/cli`；`lark-cli config init --new`（浏览器授权，自动建应用、配长连接和事件）；`lark-cli auth login --recommend`（用户身份）；`lark-cli auth list`（`docs/cli-notes/feishu.md:31-41`）。
- 发消息一律 `--as bot`：用户身份代发的权限没开（`cli-notes/feishu.md:18`）。
- 代码里用到的命令：
  - 发卡：`im +messages-send --as bot --chat-id <群> --msg-type interactive --content <卡片JSON> --format json -q .data.message_id`（`hub-ask.mjs:111-119`）
  - 改卡：`im messages patch --as bot --message-id <id> --data {"content":…}`（`broadcast-io.mjs:124-139`）
  - 发文本：`im +messages-send --as bot --chat-id <群> --text <正文>`（`broadcast-io.mjs:142-160`）
  - 列群：`im +chat-list --as bot --format json --page-all`；退群：`im chat.members delete --as bot`（`broadcast-io.mjs:162-187`）
  - 查群：`im chats get --as bot --chat-id <群> --json`；`auth status --json`（`feishu-groups-check.mjs:187-193`）
  - 建群：`im +chat-create --as bot --chat-mode group --users <用户> --set-bot-manager`
- 备选事件源 `lark-cli event consume im.message.receive_v1 --as bot`（密钥不出 CLI），没用上（`cli-notes/feishu.md:53-61`）。
- 实机 lark-cli 1.0.96；配置目录同时持有机器人身份和一位创始人的用户身份【读回】（windsurf-dao#801「实况接线记录」）。

### 1.9 凭据与状态（只写种类，不写位置）

| 东西 | 备注 |
|---|---|
| 应用凭据（appId / appSecret / 总控群 / 放行名单） | 600，不进 git；所在目录归 ai-gateway-stack 管（`docs/cli-notes/feishu.md:21`） |
| 实机群映射（群编号 → 仓） | 放机器本地；文档要求 600，实机读回是 664——权限要读回，不能只写在文档里 |
| 机器人调大模型的 key | 放机器本地（windsurf-dao#823） |
| 网关地址、模型名（非密钥） | 公开的环境文件，644 |
| 网关令牌等密钥 | 密钥环境文件，600、root 所有 |
| lark-cli 身份 | 机器人 + 一个用户身份，都在 lark-cli 自己的配置目录 |
| 仓外发群脚本 `hub-say` | 不在任何仓里管（windsurf-dao#1012） |
| 话题状态 / 卡片索引、总控对话记录、日报队列 | `~/.dao/` 下的 JSON / NDJSON 文件（`feishu-threads.json`、`hub-chat/<日期>.ndjson`、`broadcast-digest.json`）；新系统进 Postgres |
| GitHub 写身份 | issue-gateway + 帅位机器人凭据；进程卸掉个人 token、`GH_CONFIG_DIR=/var/empty`（`host/machine/systemd/feishu-triage.service`） |

### 1.10 运维面

- systemd：`Restart=always`，两份环境文件（公开/密钥），卸掉个人 GitHub token（`host/machine/systemd/feishu-triage.service`）。
- 吃新码：dao-sync 每 5 分钟按「活进程启动时刻 vs 加载文件修改时间」判，旧了就重启（`scripts/server-sync.sh:9-10`）。实机 40 小时重启 18 次（2026-09-23 01:11 → 09-24 17:06）【读回】。
- 检查：server-check ⑫ 只看服务 active + 凭据文件在；⑰ 只看机器人用的模型在网关里还有货（`scripts/server-check.mjs:159-274, 1527, 1534`）。
- 日志：stdout 是 JSON Lines（`inbound/reply/action/…`，`feishu-triage.mjs:53-58`）；但 journald 被其它大户撑到 500M 上限，只剩 2 天（`scripts/dispatcher.mjs:188-191` 注释；【读回】最早一条 2026-09-22 23:26，期间 0 条入站）。

### 1.11 使用数据【读回，2026-09-25】

| 项 | 数 |
|---|---|
| 项目群需求线程 | 1 个（2026-09-03 接线当晚，4 条消息，首条到最后更新 48 分钟，已建单） |
| 总控群/私聊问答记录 | 6 条（2026-09-04～06；4 条问盘面、2 条超范围；0 条落成拍板），此后 0 |
| 待拍板卡 | 148 张 / 84 件事；24 件事不止一张；最多一件 20 张（windsurf-dao#1182），其次 7 张（#1178）、6 张（#1184） |
| 卡片按钮点击落账 | 5 次，全是「按推荐执行」（09-12、09-13 各 1，09-16 3 次）；138 张由机器改成「别处处理」；5 张悬空 |
| 卡片来源 | 指挥官报帅 55、指挥官盘点 7、未标来源 86 |
| 日报队列 | 上次发出 2026-09-18；之后入队 103 条一条没发（来源：指挥官 27、清卡 26、总控 16、派单 16、fleet 报警 12、发布 6） |
| 总控问答的数据源 | 指挥官态势文件 0 份；健康表停在 09-20；熔断表停在 09-18 |
| 判断题小模型影子账（hub-intent/feishu-dedup） | 没有文件（功能上线后没有消息进来） |

### 1.12 值得带走的做法

- 长连接收事件，服务器不开端口——和设计 §三-6「VPS 不开任何端口」一致。
- 按钮回调先回 toast、重活放后面；回包路径不打网（`feishu-triage.mjs:844-965`）。
- 送达只认飞书 `message_id`（`hub-ask.mjs:69-86`）。
- 群消息 id 当 GitHub 写入的幂等键，重投不重复建单（`feishu-triage-core.mjs:103-109`）。
- 飞书只是投影、真相在别处；对账「没查成」时不许把卡判成已办结（`hub-pending.mjs:1-6, 149-163`）。
- 「当前没有」和「没查成」分开说（`hub-pending.mjs:251-276`）。
- 日报编辑口径：只报变化、一个头条数字、每个指标带变化量、状态色必须配图标加文字、没变化不发（windsurf-dao#1052）。
- 内部代号先过白话表再给模型看（`feishu-triage-core.mjs:81-99`）。
- 文件事件源测试（fixture JSONL + 假 gh），测试不碰 SDK、不出网（`feishu-triage.mjs:8-9, 1233-1268`；`tests/fixtures/fake-feishu-gh.mjs`）。

### 1.13 旧系统里该丢掉的

- **固定三问（至少两轮）与「总控群 / 项目群」分工**（2.4-1、2.4-3、2.4-4）→ 一句话 + 一张「我理解为」确认卡，最多追问一次；私聊和团队群里都能记任务。
- **「待拍板」做成消息流、按时间去重（6 小时重发）**（2.1-1、2.1-3）→ 一件事一张卡，状态变了原地更新。
- **8 个以上各自为政的发群出口、测绿却没接线的播报闸**（2.1-4）→ 一个发送出口：类别白名单 + 按「对象 + 状态」去重 + 每日预算 + 免打扰（T16）。
- **Card JSON 1.0、卡片被拒就降级成纯文本墙**（2.3-3）→ 全部 JSON 2.0，发出前在测试群真发验证（T21）。
- **全进程一条串行队列、连「你好」也走大模型、人格规则「不说收到」**（2.2-1、2.2-3、2.2-4）→ 2 秒内表情回执，重活放后台，不让一条慢消息挡住所有人。
- **仓外发群脚本与 lark-cli 子进程发消息**（1.1、2.3-4）→ 统一走官方 Node SDK；lark-cli 只留给运维与自测。
- **入队即回执的日报队列**（2.1-8）→ 拿到飞书 `message_id` 才算送达（T17）。
- **建了又建的群（话题群 → 普通群 → 播报群）**（2.3-1）→ 一个团队群 + 各自私聊 + 一个测试群；建群幂等（T29）。
- **新旧两个进程连同一个飞书应用**（4.3 第 1 条集群模式）→ fleet-dao 新建应用（设计 §15.4 已定）。

---

## 二、四个毛病的成因

### 2.1 太吵

| # | 成因 | 出处 | 类型 |
|---|---|---|---|
| 1 | 「待拍板」是一个状态，却做成了消息流：发一次就躺在群里被新消息冲走，处理过的也不消失。用户原话「飞书群的消息太多了，我无法专注于看到所有信息」 | windsurf-dao#1029 正文（2026-09-06） | 实咬 |
| 2 | 机器向人求助的速率失控：报帅一律贴「待拍板」、每张都发卡。5 天堆 27 张，真要拍的 4 张；更早一晚 11 张里 10 张是假警报，靠用户截图才发现 | windsurf-dao#1389；提交 `49d124b96`（windsurf-dao#1090） | 实咬 |
| 3 | 按时间去重、不按状态去重：同一件事状态没变，6 小时一到再发一张卡；已开单的也照发 | `scripts/lib/commander-verbs.mjs:42`；`scripts/commander.mjs:939-950, 3384-3392`；`scripts/lib/broadcast-gate.mjs:8-10` 自述「状态没变但过了 6 小时又发一遍（刷屏）」；【读回】#1182 一件事 20 张卡 | 实咬 |
| 4 | 发群出口不收口：至少 8 个触发点各自决定播什么；专门做的播报闸（一份账 + 按内容去重 + 每日预算）测绿了，生产 0 个调用方。至今还在加新的直发口（2026-09-24 加了额度 80% 报警、fleet 报警直发） | windsurf-dao#891 正文；`docs/observations/2026-09-14-播报闸没接线.md`；`scripts/dispatcher.mjs:176-185`；`scripts/fleet-escalations-apply.mjs:49`；`scripts/board-officer.mjs:552`；提交 `aa323a6aa`、`2ea6df5a8` | 实咬 |
| 5 | 2026-09-05 刷屏事故：预演也真发、每轮对同一对象重发、按终端而不是按卡去重、一轮 66 条全列 | `docs/decisions/SERVER-LANDING-CHECKLIST.md:144-159`（提交 `ea3aa31`/`c78a9ae`）；`scripts/dispatcher.mjs:173` | 实咬 |
| 6 | 播报是纯文本墙，没层级、没重点。用户：「现在的格式太难看了」 | windsurf-dao#1052 正文 | 实咬 |
| 7 | 结果：148 张卡、按钮点击落账 5 次、138 张最后是机器自己收掉——绝大多数推送不需要人 | 【读回】见 1.11 | 读回 |
| 8 | 反面：日报队列「入队即回执」，发日报的指挥官退役后 103 条再没发出去，调用方以为送到了——吵的同时，该到的没到 | `scripts/lib/hub-chat.mjs:6-9`；提交 `2ea6df5a8`；【读回】 | 实咬 + 读回 |

### 2.2 慢或没反应

| # | 成因 | 出处 | 类型 |
|---|---|---|---|
| 1 | 没有即时回执：人格规则明文「不说『收到』」，用户第一眼看到的就是整条流水线跑完后的结果 | `host/skills/feishu-triage/persona.md:10`；`feishu-triage.mjs:1196-1212`（triage 完才回话） | 代码 |
| 2 | 一条消息串行等 2–3 次大模型：项目群新需求 = gh 搜索 + 判重 + 三问（齐了再 + 渲染 + 建单）；总控群 = （旁听的小模型）+ 大模型分类 + 取盘面 + 大模型作答；每次预算 180 秒；grok 排队时单次大 prompt 实测 26 秒，原先非流式 60 秒必超时 | `feishu-triage-core.mjs:152-180, 315-381`；`feishu-triage.mjs:120-123`；windsurf-dao#862 | 实咬 + 代码 |
| 3 | 全进程一条串行队列：一条慢消息挡住后面所有群、所有人 | `feishu-triage.mjs:1296-1302` | 代码 |
| 4 | 连「你好」也要走一次大模型 | `feishu-triage-core.mjs:299-313` | 代码 |
| 5 | 模型被网关下线，每条消息都回「稍后重试」，哑了一整天零报警（日志里只有入站没有回复） | windsurf-dao#862；ai-gateway-stack `docs/DECISIONS.md:2119-2140`（§70） | 实咬 |
| 6 | 按钮是死的：应用没订阅卡片回调，点了只弹「该应用尚未配置卡片回调」，到 2026-09-06 应用发版才通 | windsurf-dao#1029 评论（2026-09-06）；windsurf-dao#1052「邻居」段 | 实咬 |
| 7 | 点按钮超时：点「看待拍板」后主线程同步等十几次网络请求、卡约 30 秒，这时点「按推荐执行」飞书报超时（GitHub 其实收到了） | PR windsurf-dao#1185；`scripts/lib/feishu-io.mjs:1`；`tests/feishu-responsive.test.js` | 实咬 |
| 8 | 修好的代码没进活进程：合并两次、进程两天没换 | `docs/observations/2026-09-14-飞书triage合了码没重启.md`；windsurf-dao#1337 | 实咬 |
| 9 | 发群口静默失败：hub-say 不在 systemd 的 PATH 里，回流整条静默；lark-cli 跑通不等于飞书收到 | `SERVER-LANDING-CHECKLIST.md:134`；提交 `29dfba6e2` | 实咬 |
| 10 | 接线期事件被静默丢：后台改完没发版事件不推；SDK 扁平结构不认 | windsurf-dao#801「接线记录·补充 5」①② | 实咬 |
| 11 | 频繁重启可能掐断在途回复：40 小时 18 次重启；收到 SIGTERM 立刻 `process.exit(0)`，不等在途的模型调用和回复 | 【读回】journal；`scripts/server-sync.sh:9-10`；`feishu-triage.mjs:1308-1313` | 推断（没抓到丢消息的实例） |
| 12 | 没有一道检查量「发一句、多久回」：⑫看进程、⑰看模型 | `scripts/server-check.mjs:159-274, 1527, 1534` | 代码 |
| 13 | 时延没法复盘：没有落「收到→回复」耗时，journal 只剩 2 天 | 【读回】；平时时延分布：**没查成** | 读回 |

### 2.3 群和卡片太乱

| # | 成因 | 出处 | 类型 |
|---|---|---|---|
| 1 | 群建了又建：3 项目群 + 1 总控群（话题群）→ 改建普通群 → 再加播报群；删群权限没开删不掉、机器人自己也退不出（成员接口 404），只好把 4 个旧群编号写死在代码里 | windsurf-dao#801 补充 4；`docs/cli-notes/feishu.md:16-17`；windsurf-dao#1029「硬边界」；`broadcast-digest.mjs:7-20` | 实咬 |
| 2 | 一件事多张卡：来源一是 6 小时重发（2.1-3）；来源二是「看待拍板」更新旧卡失败就发新卡替换（旧索引可能指向降级纯文本或已删卡） | 提交 `065d6ac8b`；`feishu-triage.mjs:1097-1112`；【读回】148 张/84 件 | 实咬 + 读回 |
| 3 | 卡片两套版式（待拍板 1.0、日报 2.0），被拒就降级成纯文本墙 | `feishu-hub-card.mjs:1-3, 83-84`；`feishu-daily-card.mjs:1-4`；`feishu-card-text.mjs` | 代码 |
| 4 | 发群格式四套：SDK 卡片、lark-cli 卡片、lark-cli 纯文本、仓外 hub-say 纯文本 | 见 1.3、2.1-4 | 代码 |
| 5 | 待拍板卡三个按钮、机器味标题、正文 7 行；用户说 GitHub 链接「大概率不点」 | `feishu-hub-card.mjs:34-53, 86, 97-110`；windsurf-dao#875 评论⑤ | 实咬 + 代码 |
| 6 | 菜单设计错位：按「群输入框下方菜单」设计，官方文档写明机器人菜单**只支持单聊**；菜单事件**不带群编号**，旧代码取不到就回落发到总控群 | windsurf-dao#1029 评论；`feishu-triage.mjs:705, 1068, 1083`；`hub-pending.mjs:424-449`；【文档】机器人菜单使用指南、菜单事件 | 代码 + 文档 |
| 7 | 配置散落：仓内占位、实机一份、`~/.dao` 旧一份、`.bak` 一份；实机映射里有一个群机器人已不在 | 【读回】 | 读回 |

### 2.4 听不懂、反复追问

| # | 成因 | 出处 | 类型 |
|---|---|---|---|
| 1 | 固定三问（做到什么算做完 / 现在做还是先记着 / 要不要写进文档）缺一必问、一轮最多 2 条 → 三条都没答至少两轮；后两问是流程问题 | `feishu-triage-core.mjs:68-74, 167-179`；`persona.md:12, 33-37` | 代码 |
| 2 | 答过的又被问：状态读的是启动快照；网页端「回复」机器人消息会另开话题，状态机当成新需求重问 | windsurf-dao#801 补充 5 ④⑤；`feishu-triage.mjs:322-324, 648-649` | 实咬 |
| 3 | 出题的地方不收答案：总控群里机器人提的问题，用户原地回复被回「这里是总控群，需求请发到项目群」 | windsurf-dao#852 | 实咬 |
| 4 | 私聊被当成未映射群打发（PR 自述）；修过之后私聊提新需求，代码仍回同一句（测试只覆盖私聊问盘面） | PR windsurf-dao#1103「机制判定」；`feishu-triage-core.mjs:59, 132-133, 333-334`；`tests/hub-chat.test.js:236` | 实咬 + 代码 |
| 5 | 答非所问：总控群说「你好」，机器人甩一整段盘点 | windsurf-dao#875 | 实咬 |
| 6 | 黑话：「唤醒用尽」是 wake-exhausted 直译；追问里出现目录名「是否 docs/memory 该记」 | 提交 `eccd1d65f`（windsurf-dao#919）；`feishu-triage-core.mjs:66-67, 81-99` | 实咬 |
| 7 | 没有背景：判重只拿原话前 300 字去全文搜；判重/三问/渲染的提示词只有这段对话，没有仓的近况和最近任务；盘面问答的数据源现在是空的 | `feishu-triage-core.mjs:566, 607-620, 641-650, 791-793`；【读回】1.11 | 代码 + 读回 |
| 8 | 只收纯文本：图片、富文本、文件直接跳过，用户看到的就是不回 | `feishu-triage.mjs:153-154` | 代码 |

---

## 三、坑 → 新系统测试用例（只收真实踩过的）

| # | 测试用例 | 出处 |
|---|---|---|
| T1 | 给定开发者后台新增了事件/权限/回调/菜单，当部署完成，应当由上线自检真发一条测试消息、N 秒内收到对应事件，收不到判「接入未生效」并报警——不以「长连接已建立」为准 | windsurf-dao#801 补充 5 ①（连上了但一个事件都不推）；windsurf-dao#1029 评论（按钮回调未订阅） |
| T2 | 给定长连接推来的是扁平结构或嵌套结构的事件，当解析，应当都能识别；认不出的要记日志并计数，不许静默丢 | windsurf-dao#801 补充 5 ②；`feishu-triage.mjs:142-144`；`feishu-hub-card.mjs:155-156` |
| T3 | 给定群里 @机器人 的文本，当解析，应当剥掉 `@_user_N` 占位、并用 mentions 判断是不是 @ 了本机器人 | windsurf-dao#801 补充 5 ③ |
| T4 | 给定用户在网页端对机器人消息点「回复」，当事件的 root_id/parent_id 指向机器人消息，应当归到原来那件任务，不当成新需求 | windsurf-dao#801 补充 5 ④ |
| T5 | 给定同一会话连发两条消息，当第二条到达，应当读到第一条写下的最新状态（状态在库里，不用启动快照） | windsurf-dao#801 补充 5 ⑤ |
| T6 | 给定大模型首字节要 30 秒以上或直接不可用，当用户发来一句话，应当 2 秒内仍有「收到」——回执不依赖模型 | windsurf-dao#862（60 秒超时、26 秒排队）；`persona.md:10` |
| T7 | 给定后台正在做一件要 30 秒的网络操作，当用户点卡片按钮，应当 3 秒内回 toast | PR windsurf-dao#1185；`tests/feishu-responsive.test.js` |
| T8 | 给定通讯录接口挂死，当用户点按钮，回包不等通讯录，3 秒内给 toast | 提交 `a42e4d14c`（windsurf-dao#875 审官疑问） |
| T9 | 给定机器人用的模型或路由被下线，当巡检真发一句话，应当在一个巡检周期内报「机器人不回话」——以真收到回复为准，不以进程活着、模型在列表里为准 | windsurf-dao#862；ai-gateway-stack `docs/DECISIONS.md` §70 |
| T10 | 给定模型调用失败只能回兜底话，当连续失败，应当每次记下原因并计数，超阈值报警，不许静默兜底 | windsurf-dao#801 补充 5 ⑥（「静默兜底实咬三次」）；`feishu-triage-core.mjs:116-118` |
| T11 | 给定新版本已合入，当巡检，应当核对在跑进程的版本号等于应部署版本，不一致报警 | `docs/observations/2026-09-14-飞书triage合了码没重启.md`；windsurf-dao#1337 |
| T12 | 给定同一件事状态没变，当调度跑了很多轮（跨 6 小时、跨天），群里应当始终只有它一张卡（原地更新），不按时间重发 | `broadcast-gate.mjs:8-10`；`commander-verbs.mjs:42`；【读回】#1182 一件 20 张 |
| T13 | 给定一件不属于四条人闸（对外发布/花钱/删数据/改规则）的卡住事项，当引擎处理，应当不推「要人拍」卡（最多进日报） | windsurf-dao#1389（27 张只有 4 张真要拍） |
| T14 | 给定一天内「要人拍」超过预算（数待定），当继续产生，应当报「机器在刷求助」，而不是继续推 | 提交 `49d124b96`（11 张里 10 张假警报，没东西盯这个数） |
| T15 | 给定预演/测试模式，当运行，应当一条都不发到真实群；给定一轮有几十条同类发现，应当合成一条 | `SERVER-LANDING-CHECKLIST.md:156-159`；`dispatcher.mjs:173` |
| T16 | 给定任何代码要往飞书发消息，应当只能经过一个出口（类别白名单 + 按状态去重 + 预算）；静态检查发现第二个出口即失败 | windsurf-dao#891（8 个触发点）；`docs/observations/2026-09-14-播报闸没接线.md` |
| T17 | 给定一条要人拍的通知，当发送，应当以飞书返回的 message_id 为送达凭证记账；「已入队」「命令退出码 0」都不算送达，超时未送达要报警 | 提交 `29dfba6e2`；`hub-chat.mjs:6-9`；提交 `2ea6df5a8`；【读回】103 条入队未发 |
| T18 | 给定发送依赖的外部命令或凭据缺失，当发送，应当大声失败并报警，不许整条静默 | `SERVER-LANDING-CHECKLIST.md:134`（hub-say ENOENT） |
| T19 | 给定已发的几张待处理卡被聊天冲上去，当用户问「有什么要我拍的」或点菜单，应当拿到当前全部待办（以任务库为准），不许回「没有」 | windsurf-dao#1029（15:52 发、16:24 用户以为没这个机制） |
| T20 | 给定待办已在驾驶舱或 GitHub 处理，当对账，对应飞书卡应当改成「已处理」；数据没查成时不许改 | windsurf-dao#1029 ② |
| T21 | 给定卡片 JSON 里有飞书不支持的标签（如 2.0 里的 note），当 CI 跑，应当在发出前被拦下（真发到测试群验证），不许到生产才发现一张都发不出去 | 提交 `bed97d37f`（windsurf-dao#1052，错误码 200861）；`feishu-daily-card.mjs:240` |
| T22 | 给定用户点了按钮、飞书那边超时，当用户再点一次或另一位创始人也点，应当只落一次决定，第二次提示「已经处理过」 | PR windsurf-dao#1185（GitHub 收到了、飞书报超时）；windsurf-dao#1012 验收③ |
| T23 | 给定某张「卡」其实是降级后的纯文本，当之后要更新它，应当识别出来、只补发一次并作废旧索引，不许每次刷新都新发一张 | 提交 `065d6ac8b` 注释；【读回】重复卡 |
| T24 | 给定机器人在群里发出的问题卡，当用户直接回复，应当记成对这件事的回答，不许回「去别处说」 | windsurf-dao#852 |
| T25 | 给定私聊机器人说一个新需求，应当走记任务流程（收到 + 确认卡），不许回「这里是总控群，需求请发到项目群」 | PR windsurf-dao#1103「机制判定」 |
| T26 | 给定「你好」「在吗」，应当一两句短回应，不出现盘面数字 | windsurf-dao#875 |
| T27 | 给定内部原因代码（如 wake-exhausted）或目录名，当生成给人看的文字，应当经白话表转换，出现内部代号即失败 | 提交 `eccd1d65f` |
| T28 | 给定用户一句话已说清要做什么，当生成确认卡，应当不再问「现在做还是先记着」「要不要写进文档」；一件事最多追问一次 | 设计 §15.4 创始人反馈；`feishu-triage-core.mjs:167-179`；【读回】唯一一次建单走了 4 条消息 |
| T29 | 给定部署脚本要建群，应当先按名字查是否已有（幂等），群模式固定普通群，不许重复建（建了删不掉） | `docs/cli-notes/feishu.md:16-17`；windsurf-dao#1029「硬边界」 |

---

## 四、§15.4 要用的飞书接口与已知限制

### 4.1 按四件事拆

**① 随手记任务**

| 动作 | 飞书能力 | 权限 | 关键限制（文档） |
|---|---|---|---|
| 收话 | 事件 `im.message.receive_v1`（长连接） | 私聊 `im:message.p2p_msg:readonly`；群里 @ `im:message.group_at_msg:readonly` | 3 秒内处理完且不抛异常，否则重推；可能重复推送，按 `message_id` 去重；群里只收 @ 本机器人的（收全部要敏感权限 `im:message.group_msg`） |
| 2 秒「收到」 | 推荐 **添加表情回复** `POST /im/v1/messages/:message_id/reactions`（不多一条消息）；或 回复消息 `POST /im/v1/messages/:message_id/reply` | `im:message.reactions:write_only`；`im:message:send_as_bot` | 发消息：同一用户 5 QPS，同一群所有机器人共享 5 QPS |
| 10 秒确认卡 | 回复消息，`msg_type=interactive`，卡片 JSON 2.0 | 同上 | 卡片 ≤30 KB；`uuid` 同值 1 小时内至多成功一条（重试不重复） |
| [确认][改一下] | 回调 `card.action.trigger`（长连接接收回调） | 无需额外权限 | 3 秒内回包（toast + 同版本卡片）；回调里的 token 30 分钟内可延时更新 2 次；「改一下」可放卡内表单输入框，回调带 `form_value`/`input_value` |

**② 只推三类 + 关注**

| 动作 | 飞书能力 | 权限 | 关键限制 |
|---|---|---|---|
| 推卡到团队群 / 私聊 | 发送消息 `POST /im/v1/messages`（`receive_id_type=chat_id` 或 `open_id`） | `im:message:send_as_bot` | 私聊对象要在应用可用范围内，否则 230013 |
| 批准/拒绝/叫停/关注 | 卡片按钮回调 | — | 同上 3 秒 |
| 打开驾驶舱对应页 | 卡片按钮「打开链接」 | — | 在飞书内置浏览器里过 Cloudflare Access 的体验要实测（第五节） |

**③ 随时看盘面**

| 动作 | 飞书能力 | 权限 | 关键限制 |
|---|---|---|---|
| 置顶盘面卡 | 发卡 + **更新群置顶** `POST /im/v1/chats/:chat_id/top_notice/put_top_notice`（`action_type=1` + `message_id`）；或 **Pin** `POST /im/v1/pins` | `im:chat.top_notice:write_only`（或 `im:chat`）；Pin 用 `im:message.pins:write_only` | 机器人须在群内、同租户；群设置可能只许群主/管理员置顶或 Pin（232014 / 230046）；同一条消息 Pin 操作 ≤5 QPS |
| 原地刷新 | **更新卡片** `PATCH /im/v1/messages/:message_id` | `im:message` 或 `im:message:send_as_bot` | 更新前后卡片都要 `update_multi: true`；**只能更新 14 天内发出的消息**（230031）；单条 5 QPS；≤30 KB；与发卡同一身份 |
| 机器人菜单 | 开发者后台配「机器人自定义菜单」，动作选「推送事件」；事件 `application.bot.menu_v6` | 无；操作人姓名要 `application:application.bot.operator_name:readonly` | **只支持单聊**；悬浮菜单客户端 ≥7.22、最多 5 个主菜单×10 个子菜单；事件体只有 `operator.open_id`、`event_key`、`timestamp`，**没有群编号**；发版后约 5 分钟生效 |
| 群里的快捷入口（可选） | 群菜单 `POST /im/v1/chats/:chat_id/menu_tree` | `im:chat.menu_tree:write_only` | 只能跳链接，不推事件；最多 3×5；只支持普通群模式 |
| 查进度「进度 12」 | 收消息事件 + 按文本规则解析（不用模型） | 同 ① | — |

**④ 回复即追问**

| 动作 | 飞书能力 | 权限 | 关键限制 |
|---|---|---|---|
| 用户回复某张卡 | 收消息事件，`parent_id` = 被回复的消息、`root_id` = 根、话题里还有 `thread_id` | 同 ① | **群里不 @ 机器人收不到**，除非开敏感权限 `im:message.group_msg`；私聊天然全收 |
| 找到卡片上下文 | 库里存「卡片 message_id → 任务/卡片类型/快照」 | — | 旧系统实咬：网页端回复会另开话题（T4） |
| AI 在任务里追问 | 发问题卡；回复即回答（同上） | — | — |

**可选：流式卡片（CardKit）**——把「收到」和确认卡合成一条消息：先创建卡片实体 `POST /cardkit/v1/cards`（`cardkit:card:write`）发出「正在理解…」，再流式/局部更新成确认卡。限制：卡片实体 14 天有效、只能发一次、每实体 10 次/秒；流式模式开着时，用户点按钮后服务端无法立即更新卡片（【文档】流式更新卡片）。

### 4.2 新应用配置清单

- 类型：企业自建应用（长连接只支持自建）；开机器人能力。
- 权限最小集：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:message.reactions:write_only`、`im:chat.top_notice:write_only`（或 `im:message.pins:write_only`）；按需 `im:chat`（建团队群/测试群）、`cardkit:card:write`（用流式时）、`application:application.bot.operator_name:readonly`。
- 待创始人拍：`im:message.group_msg`（敏感，群里不 @ 也收全部消息），见 4.4-②。
- 事件：`im.message.receive_v1`、`application.bot.menu_v6`；回调：`card.action.trigger`，订阅方式都选长连接。
- 机器人菜单（悬浮）：盘面 / 我的待办 / 新任务 / 查进度，动作「推送事件」。
- 可用范围：两位创始人 + 测试身份。
- **每改一次权限/事件/回调/菜单都要「创建版本并发布」**（旧实咬 windsurf-dao#801 补充 5 ①）。
- 测试身份的用户授权范围：`im:message`、`im:message.send_as_user`、`im:message.group_msg:get_as_user`、`im:message.p2p_msg:get_as_user`、`offline_access`。

### 4.3 已知限制一览（均为【文档】，链接见附录 B）

1. 长连接：只支持企业自建；3 秒内处理完否则重推；每应用最多 50 个连接；**集群模式——同一应用多个客户端，每条事件只随机给其中一个**。
2. 收消息：可能重复推送，用 `message_id` 去重，别用 `event_id`；群里默认只收 @ 本机器人的。
3. 发消息：同一用户 5 QPS、同一群所有机器人共享 5 QPS；文本 ≤150 KB，卡片 ≤30 KB；`uuid` 1 小时去重。
4. 更新卡片：前后都要 `update_multi: true`；只能更新 14 天内的消息；单条 5 QPS；不能更新批量发送的、仅特定人可见的卡。
5. 卡片 JSON 2.0：客户端 ≥7.20（更低版本只显示标题和升级提示）；`update_multi` 只能为 true；每卡最多 200 个元素。卡片 JSON 1.0 的 `update_multi` 默认 false（独享：更新只有点击人看得到）。
6. 卡片回调：3 秒内回包；回包卡片与原卡同版本；延时更新 token 30 分钟、最多 2 次；错误码 200340 = 没配回调、200341 = 超时（客户端 ≥7.28 才显示错误码）。
7. 机器人菜单：只支持单聊；悬浮菜单 ≥7.22（5×10），可切换菜单 ≥5.27（3×5）；菜单名 ≤60 字；发版后约 5 分钟生效；事件不带群编号。
8. 群菜单：只能跳链接；3×5；只支持普通群模式。
9. 置顶/Pin：机器人须在群内；群设置可能只许群主/管理员操作。
10. 读消息：应用身份读群聊历史/单条群消息要 `im:message.group_msg`；用户身份要 `im:message.group_msg:get_as_user`。
11. 用户令牌：拿 refresh_token 要开 `offline_access` 并在授权时声明；refresh_token 一次性，每次刷新换新；授权满 365 天要重新授权。

### 4.4 对 §15.4 的修正建议（反过来想：哪里会被飞书卡住）

1. **「收到」用表情回复**，不发文字：2 秒内可见、群里不多一条消息（否则每个需求至少两条机器人消息，又回到「吵」）。旧人格规则「不说收到」要删（`persona.md:10`）。
2. **群里「回复即追问」要先拍板**：A. 开敏感权限 `im:message.group_msg`（机器人收到群里所有消息，自己忽略无关闲聊）；B. 约定群里回复时 @ 机器人；私聊不受影响。建议 B 起步、确有需要再上 A——推荐理由：A 让机器人读到所有闲聊，误触发和成本都上去。
3. **置顶盘面卡 14 天换一张**：每周重发一次并换置顶；刷新要合并（单条 5 QPS、群里 5 QPS 共享），不按事件逐条 PATCH。
4. **菜单只在私聊**：设计已写「私聊机器人时」，一致；团队群里别承诺菜单，入口靠盘面卡按钮（或群菜单跳链接）。菜单事件回到点击人的私聊，别回落到团队群（旧代码 `feishu-triage.mjs:1083` 的错法）。
5. **新旧切换**：集群模式下旧 feishu-triage 和新 `packages/feishu` 若连同一个应用，事件会被随机分走——§十八「旧系统原地待机」对飞书不成立。建议新系统**用新应用 + 新团队群**；若要沿用旧应用，切换当刻必须先停旧进程。
6. **全部卡片用 JSON 2.0**：两位创始人看到同一个状态（2.0 只有共享卡）；旧待拍板卡是 1.0 且没声明 `update_multi`（`feishu-hub-card.mjs:83-84`），别照搬。
7. **一个发送出口**：类别白名单（三类 + 关注）+ 按「对象 + 状态」去重 + 每日预算 + 免打扰时段，全在这一处判；其它代码不许直接调发送接口（T16）。
8. **送达凭证 = message_id 写库**，重试带同一个 `uuid`，不会重复发（T17）。
9. **优雅停机**：先停收新事件、做完在途的再退；重启期间来的事件会不会补推要实测（第五节第 11 条）。

---

## 五、开发时必须实测的点

| # | 测什么 | 怎么测 | 通过标准 |
|---|---|---|---|
| 1 | 群里回复卡片（不 @）能否收到 | 只开 `group_at_msg` 跑一次，再按 4.4-② 拍板结果跑一次 | 选定方式下回复 100% 进到机器人 |
| 2 | 三端「回复」的 root_id/parent_id/thread_id 形态 | 桌面、手机、网页各回复机器人卡片 3 次，记事件字段 | 三端都能归到原卡（旧实咬：网页端另开话题） |
| 3 | 置顶卡被 PATCH 后，置顶区显示的是不是新内容 | 置顶后改 3 次，手机、桌面各看 | 置顶区与卡片正文一致；否则改为「刷新时重新置顶」 |
| 4 | 群置顶 vs Pin 哪个更显眼、机器人有没有权限 | 两种各做一次，看手机端位置；群设置切「仅管理员」再试 | 选定一种并确认机器人需要什么群身份 |
| 5 | 14 天边界的换卡流程 | 在测试群造一张「旧卡」，跑换卡：发新卡 → 换置顶 → 旧卡改成「已过期」 | 群里始终只有一张有效盘面卡 |
| 6 | 收消息时延 | 测试身份发 20 条，记飞书消息 `create_time`、我方收到事件时刻、表情回复 `action_time` | 「收到」p95 ≤2 秒；拆出飞书推送占多少 |
| 7 | 卡片回调全链路 | 点 20 次按钮，记回调到达、回包时刻、toast 出现 | 回包 p95 远低于 3 秒（含读库） |
| 8 | 菜单 | 两位创始人客户端版本；点四个菜单，看事件与回应落点 | 版本 ≥7.22；回应落在点击人私聊；记下发版到生效的延迟 |
| 9 | 卡内输入框（「改一下」） | 手机上填写并提交 | 回调带到输入内容、卡片当场更新 |
| 10 | 驾驶舱链接在飞书内置浏览器里过 Cloudflare Access | 手机点「打开驾驶舱」，走邮箱验证码 | 能登录并保持会话；不行就改成在系统浏览器打开 |
| 11 | 进程重启期间来的事件 | 重启窗口内发消息，看重连后是否补推、多久 | 不丢；丢则停机前先排空、并提示用户重发 |
| 12 | 机器人自己发的消息在事件里 `sender_type` 是什么 | 在测试群让机器人发一条（若订阅了含机器人的消息） | 回声过滤按实测值写（文档写 `user`/`bot`，旧代码按 `app` 过滤） |
| 13 | 同一应用两个长连接的分发 | 起两个客户端连同一应用，发 20 条 | 证实随机分发，据此定切换方案 |
| 14 | 测试身份能否给机器人发私聊、在群里 @ 机器人触发事件 | 用户令牌调发送接口；私聊的 `receive_id` 用什么要试 | 两条链路都能触发事件 |
| 15 | 浏览器自动化点按钮/菜单 | Playwright 驱动飞书网页版，保存登录态，连跑 3 天 | 登录态能保持的天数；有无风控；选择器稳定性 |
| 16 | 5 QPS 共享下的排队 | 同时触发盘面刷新 + 3 条推送 | 不报 230020（限频）；有合并与排队 |
| 17 | 敏感权限的审批流程 | 若 4.4-② 选 A，走一次版本审核 | 知道谁批、要多久 |
| 18 | 流式卡片方案（可选） | 用 CardKit 把「收到→确认卡」做成一条消息，并在流式期间点按钮 | 决定用不用；流式期间按钮行为可接受 |

---

## 六、端到端自测怎么做

目标来自设计 §15.4 末段：测试群里用测试身份真发消息、真点按钮，检查每一步回应和响应时间，并进巡检任务。

### 6.1 用什么身份

- **测试身份**：企业里单独一个成员账号（推荐，和创始人分开），加进应用可用范围；由创始人做一次用户授权，开 `offline_access` 拿 refresh_token，令牌只放机器本地、加密备份，不进 git。refresh_token 一次性、每次刷新换新，授权满 365 天要重授（【文档】刷新 user_access_token）。
- 为什么不用第二个机器人代发：开 `im:message.group_at_msg.include_bot:readonly` 后机器人能收到别的机器人 @ 它的消息（【文档】接收消息），但这条路径和真人不同（私聊、菜单、按钮都测不到），只适合作「收消息链路」的备用探针。
- 读回机器人的回应也用测试身份（`im:message.group_msg:get_as_user`），**生产机器人就不用为了测试去开「读群里所有消息」的敏感权限**。

### 6.2 环境

- `<测试群>`：只有机器人 + 测试身份，普通群模式；创始人不在群里（或设免打扰），巡检不打扰人。
- 引擎把 `<测试群>` 的任务落到沙盒仓，打测试标记；跑完自动关单、清理。
- 与生产用同一个飞书应用（测的就是真配置），只在测试群里说话。

### 6.3 怎么驱动

- 发消息、回复卡片：测试身份调「发送消息」「回复消息」接口（用户身份），消息里带本轮编号 `[e2e-<轮次>-<步骤>]`；群里按 4.4-② 的决定带不带 @。
- 点按钮、点菜单：**飞书没有开放接口能代用户点**（没查到任何官方的模拟点击手段），只能用 Playwright 驱动飞书网页版（测试身份登录、保存登录态）：按本轮编号找到卡片，点按钮，读 toast。
- 旧仓的文件事件源（fixture JSONL）和假 gh 继续用于单元/契约测试，不算端到端。

### 6.4 怎么断言、怎么计时

- 时间一律用飞书服务端时间戳：用户消息 `create_time`（发送接口返回）、机器人回复的 `create_time`、卡片 `update_time`、表情回复 `action_time`；点按钮时刻在浏览器侧记。引擎在库里记「收到事件 / 发出回执 / 发出卡片 / 回包」时刻，用来拆分耗时是花在飞书还是我们。
- 读回：测试身份调「获取会话历史消息」（带 `card_msg_content_type=user_card_content` 拿原始卡片 JSON）、「获取指定消息」「获取消息表情回复」。
- 判定分两层（照旧仓规矩「墙钟只报趋势」，`windsurf-dao/AGENTS.md:48`）：
  - **红**：某一步在宽松上限（如 60 秒）内完全没有回应 → 立即报警。这是确定的量。
  - **黄**：有回应但超过设计目标（收到 2 秒、确认卡 10 秒、按钮 3 秒）→ 连续两轮黄才报警，驾驶舱画趋势。
- 噪音断言：一轮跑完，测试群里机器人发出的消息条数 = 预期条数；同一件事只有一张卡；没有三类以外的推送。

### 6.5 一轮的场景清单

| # | 步骤 | 驱动 | 断言 | 目标 |
|---|---|---|---|---|
| 1 | 收到 | 测试身份在群里 @机器人：「[e2e] 给登录页加验证码」 | 这条消息上出现机器人的表情回复（或回复） | ≤2 秒 |
| 2 | 确认卡 | — | 回复这条消息的卡片：含「我理解为」、仓名、[确认]为主按钮；只有一张 | ≤10 秒 |
| 3 | 改一下 | 浏览器点「改一下」并输入补充 | toast；卡片当场换成新理解 | toast ≤3 秒 |
| 4 | 开单 | 浏览器点「确认」 | toast；卡片变「已开成任务 #N」；沙盒仓出现 issue，记录提出人=测试身份 | toast ≤3 秒；issue ≤30 秒 |
| 5 | 推送 | 引擎给该测试任务注入「卡住」 | 收到一张卡住卡，一个主按钮，不重复 | ≤一个调度周期 |
| 6 | 关注 | 浏览器点「关注」，再让任务走到下一关键节点 | 只私聊推给测试身份，群里不推 | — |
| 7 | 菜单 | 浏览器在私聊点「盘面」「我的待办」 | 私聊收到对应卡片 | ≤3 秒 |
| 8 | 查进度 | 测试身份私聊发「进度 N」 | 进度卡，数字与库一致 | ≤3 秒 |
| 9 | 盘面卡刷新 | 引擎改一个状态 | 置顶卡 `update_time` 变、内容变、群消息条数不变 | ≤刷新周期 |
| 10 | 按钮回传 | 浏览器点盘面卡「刷新」 | toast + 卡片更新 | ≤3 秒 |
| 11 | 回复追问 | 测试身份回复确认卡：「N 为什么卡住？」 | 收到回执；机器人回复这一条，内容引用该任务的数据 | 收到 ≤2 秒 |
| 12 | AI 追问 | 引擎让测试任务 `fleet ask` 一个问题 | 出现问题卡；测试身份回复后答案写回任务 | — |
| 13 | 噪音预算 | 统计本轮 | 机器人消息数 = 预期 | — |
| 14 | 清理 | 关沙盒 issue、把测试卡标成已结束 | — | — |

### 6.6 并进巡检

- 每 6 小时一轮（设计 §三-15、§六-3），结果写库，驾驶舱显示最近几轮各步耗时。
- 浏览器登录态失效时报「巡检失明：按钮/菜单这轮没测」，不报「机器人坏了」——「没测成」和「测过没事」分开显示（设计 §六-5）。
- 登录态保不住时的退路：只跑接口层（第 1、2、4 的开单改由引擎侧确认、5、8、9、11、12、13），按钮和菜单只在人手验收时点，并在报告里写明「未覆盖」。

---

## 附录 A：旧仓关键文件

| 文件 | 管什么 |
|---|---|
| `scripts/feishu-triage.mjs` | 长连接、归一化、串行队列、回话/发卡/改卡、按钮回调、菜单、状态落盘 |
| `scripts/lib/feishu-triage-core.mjs` | 判重、三问、建单、两档放行；总控/私聊问答 |
| `scripts/lib/feishu-hub-card.mjs` | 待拍板卡（1.0）与按钮回调解析 |
| `scripts/lib/feishu-daily-card.mjs` | 日报卡（2.0） |
| `scripts/lib/hub-pending.mjs` | 待拍板对账、菜单「看待拍板」 |
| `scripts/lib/hub-ask.mjs`、`scripts/lib/hub-chat.mjs`、`scripts/lib/broadcast-io.mjs` | lark-cli 发卡/发文本/改卡/退群、日报队列 |
| `scripts/lib/broadcast-gate.mjs` | 播报闸（测绿、未接线） |
| `scripts/lib/feishu-group-profile.mjs`、`scripts/lib/feishu-groups-check.mjs` | 每群人格、群有效性检查 |
| `host/skills/feishu-triage/persona.md`、`host/skills/feishu-ops/SKILL.md`、`docs/cli-notes/feishu.md` | 人格、运维、lark-cli 坑 |
| `host/machine/systemd/feishu-triage.service` | 服务单元 |
| windsurf-dao#801 / #852 / #875 / #1012 / #1029 / #1052 / #1185 / #1337 / #1389 / #891 | 需求、实咬与修法 |
| `docs/observations/2026-09-14-飞书triage合了码没重启.md`、`docs/observations/2026-09-14-播报闸没接线.md` | 巡检发现 |
| ai-gateway-stack `docs/DECISIONS.md` §70（`:2119-2140`） | 模型被砍机器人哑一天 |

## 附录 B：飞书官方文档（2026-09-25 取的 `.md` 版本）

- 使用长连接接收事件：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
- 接收消息事件：https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
- 发送消息：https://open.feishu.cn/document/server-docs/im-v1/message/create
- 回复消息：https://open.feishu.cn/document/server-docs/im-v1/message/reply
- 更新已发送的消息卡片：https://open.feishu.cn/document/server-docs/im-v1/message-card/patch
- 卡片回传交互回调：https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication
- 卡片 JSON 1.0 / 2.0 结构：https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-structure 、https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure
- 流式更新卡片：https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview
- 机器人菜单使用指南：https://open.feishu.cn/document/client-docs/bot-v3/bot-customized-menu
- 机器人自定义菜单事件：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/bot/events/menu
- 群菜单（添加）：https://open.feishu.cn/document/server-docs/group/chat-menu_tree/create
- 更新群置顶：https://open.feishu.cn/document/server-docs/group/chat/put_top_notice
- Pin 消息：https://open.feishu.cn/document/server-docs/im-v1/pin/create
- 添加 / 获取消息表情回复：https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create 、https://open.feishu.cn/document/server-docs/im-v1/message-reaction/list
- 获取会话历史消息 / 获取指定消息：https://open.feishu.cn/document/server-docs/im-v1/message/list 、https://open.feishu.cn/document/server-docs/im-v1/message/get
- 刷新 user_access_token：https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token

（以上页面在浏览器里是动态渲染；在链接后加 `.md` 可取纯文本版。）
