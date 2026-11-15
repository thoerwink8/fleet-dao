---
name: discuss
description: 派活前按档让别家挑错时读（小活不讨论；中活便宜两家；大活 3 到 4 家）。用户说「讨论一下」「让别家看看」时也读。
---

# `discuss`：讨论

讨论由指挥官在派活前做，不让子会话自己讨论。结论写进单的「怎么算做完」和风险；子会话照单干，开工时发现交代自相矛盾才回报。

## 何时用

三档，别每单都讨论：

- 小活（单文件、可回退、验收明确）：不讨论。
- 中活（跨模块、新机制、要写方案）：一轮便宜挑错。路由组写 `deepseek-pool,kimi-pool` 或 `deepseek-pool,glm-pool`，各问一轮，意见并进单。
- 大活（重大且难回退：掏钱、删不可恢复、改标准、改架构、对外发布）：从 `gpt-pool,grok-pool,deepseek-pool,kimi-pool,glm-pool` 里挑 3 到 4 家（界面类偏 `kimi-pool,glm-pool`），最多 5 轮。盲设计才做第 0 轮。
- 国模组 `cn-pool（需要时再选）` 不进默认那五家。
- 用户说「讨论一下」「让别家看看」时按上面的档，不默认全套。
- 方案里有创始人没说清、没认同的前提，先用大白话问他一两句对齐，再找别家挑错。

## 做法

每轮一问一答：对方看不到仓、不跑命令，材料里附上相关规则原文、数据和出处。

1. 盲设计才做第 0 轮：只写题面（背景、诉求、要回答的），不带自己的方案。大活才用。
2. 挑错：把方案发给所选路由组，问框架对不对、漏了什么；第 1 轮起题面带【推演】段，从创始人的角度按阶段列边界和最坏情况。
3. 接着聊：意见你不认或冒出新分歧，把你的回应和新证据发回去。意见一致、分歧说清（双方主张没变、证据没新增）、到 5 轮，就停。中活一轮就停。
4. 交给人只写三样：一致的、还剩的分歧、推荐哪个；对方每条意见写明收没收、为什么。写进单的「怎么算做完」和风险。

## 本机工具

脚本在本技能 `scripts/`，下面写成 `$S`（Claude Code：`~/.claude/skills/discuss/scripts`；别家：`~/.agents/skills/discuss/scripts`）。

`node $S/ask.mjs --text 题面.md --round <0|1|2…> --models deepseek-pool,kimi-pool [--limit 180] [--out 目录]`

- 模型只走本机 magpie 网关（OpenAI 兼容 `chat/completions`）。地址默认 `http://127.0.0.1:3425/v1`，只用 `DISCUSS_MAGPIE_BASE_URL` 改（不读 `DISCUSS_GPT_BASE_URL`，那是旧中转）。密钥在 `~/.fleet-dao/discuss.env` 的 `DISCUSS_MAGPIE_API_KEY` 或 `DISCUSS_GPT_API_KEY`（进程里同名变量优先，显式空值等于没配）。不往仓里写密钥。`--models` 只写路由组名，逗号隔开：`gpt-pool,grok-pool,deepseek-pool,kimi-pool,glm-pool,cn-pool`。发给网关的模型名就是这个路由组名。
- 没配密钥，或把地址、密钥显式设空：退出码 2，明说没讨论成，不改走别的工具。
- 每家硬超时默认 180 秒（`--limit` 最多 300），最多 3 家同时问。超时、非 2xx、空回答、不是 JSON、连不上都记「没答上」。至少一家答上退出码 0，一家都没答上退出码 2。
- `ask.mjs` 每次都是新会话，接着聊要把上一轮原话贴进新题面。
- 拍板前让不同族的反方读整份分析：`node $S/second-opinion.mjs --text 材料.md --author-family <族[,族…]> [--models <路由组[,…]>]`。`--author-family` 写路由组或族名（`gpt-pool,grok-pool,deepseek-pool,kimi-pool,glm-pool,cn-pool`，也认不带 pool 后缀的族名，以及 `claude`）。同族不问。不给 `--models` 时按 gpt、grok、deepseek、kimi、glm 的路由组问作者以外的族，不含国模组；界面类（`--ui`）且没点名时只问 `kimi-pool,glm-pool`。走同一条网关；没配同样退出码 2。退出码 0 同意、1 有异议、2 没查成（不算同意）。
