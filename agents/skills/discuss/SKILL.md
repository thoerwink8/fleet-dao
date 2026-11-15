---
name: discuss
description: 重大方案拍板前让别家挑错时读（magpie 默认 GPT、Grok、DeepSeek、SWE 四家，没收敛接着聊）。用户说「讨论一下」「让别家看看」时也读。
---

# `discuss`：讨论

## 何时用

- 重大且难回退的方案拍板之前（不管是问创始人还是自己拍）：要掏新钱、删了找不回的、改标准、和已拍的规矩冲突、新加外部服务、改架构或阶段划分；用户说「讨论一下」「让别家看看」。小方案、已收敛成 A 还是 B 的小选择题不用。
- 方案里有创始人没说清、没认同的前提，先用大白话问他一两句对齐，再找别家挑错；前提没对齐，别家讨论得再细也是白费。

## 做法

每轮一问一答：对方看不到仓、不跑命令，材料里附上相关规则原文、数据和出处。

1. 盲设计才做第 0 轮：只写题面（背景、诉求、要回答的），不带自己的方案。
2. 挑错：把自己的方案发给讨论模型，问框架对不对、漏了什么；题面带【推演】段，从创始人的角度按阶段列边界和最坏情况。
3. 接着聊：意见你不认或冒出新分歧，把你的回应和新证据发回去。意见一致、分歧说清（双方主张没变、证据没新增）、到 5 轮，就停。
4. 交给人只写三样：一致的、还剩的分歧、推荐哪个；对方每条意见写明收没收、为什么。

## 本机工具

脚本在本技能 `scripts/`，下面写成 `$S`（Claude Code：`~/.claude/skills/discuss/scripts`；别家：`~/.agents/skills/discuss/scripts`）。

`node $S/ask.mjs --text 题面.md --round <0|1|2…> [--models gpt,grok,deepseek,swe[,haiku]] [--gpt-model 型号] [--swe-model 型号] [--deepseek-model 型号] [--grok-model 型号]`

- 先探本机 magpie 的 `GET http://127.0.0.1:3425/v1/models`，两秒内可用就经同一条 OpenAI 兼容 `chat/completions` 默认并行问 GPT（`recodex/gpt-6-astra`）、Grok（`grok/grok-4.7`）、DeepSeek（`chaeng/deepseek-v4.1-flash`）、SWE（Devin，`devin/swe-2`）各一家。最多三个请求同时跑，后续请求排在空出的槽位里。快速轮可用 `--gpt-model recodex/gpt-6-luna`。每家答案带固定型号、厂商族。
- `--models` 显式选族（例如 `gpt` 只问 GPT，`gpt,swe,deepseek,grok` 问四家）；`--<族>-model` 换同族型号。`~/.fleet-dao/discuss.env` 支持 `DISCUSS_MODELS`、`DISCUSS_MODEL_GPT`、`DISCUSS_MODEL_SWE`、`DISCUSS_MODEL_DEEPSEEK`、`DISCUSS_MODEL_GROK`、`DISCUSS_MODEL_HAIKU`；参数优先于配置。进程同名环境变量优先于文件。
- magpie 的 Cursor 渠道只允许 Haiku 5.5（`cursor/claude-haiku-5-5@300k`），默认不开；`--models haiku` 或在模型列表加 `haiku` 可选，`--haiku-model` 可换同族允许型号。Haiku 的厂商族是 Claude，不能作为 Claude 作者的不同族反方。Cursor 的 Gemini、Kimi 和其他型号不进 magpie 讨论。
- 网关地址可用 `DISCUSS_MAGPIE_BASE_URL` 改，Bearer 可用 `DISCUSS_MAGPIE_API_KEY` 改（默认使用本地占位值，无须真实密钥）；这两个变量任一显式设空可停用探测。固定型号必须在网关名单里，禁止 `claude/*`（Claude Code 渠道）、`antigravity/*`、Google 官方 `gemini/*`，不选 `group/*` 或 `auto/*` 路由组。
- 没 magpie 的机器保持旧路：默认只问 GPT，`DISCUSS_GPT_BASE_URL` 和 `DISCUSS_GPT_API_KEY` 都配了就走同一份 OpenAI 兼容请求代码（默认 `gpt-6-luna`）；没配才走 Cursor。其他旧族用 `--models gpt,kimi,glm` 选择。Cursor 必须装好并登录，没装、没登录照实报没讨论成；界面题仍用 Kimi/GLM，不给 GPT。
- 每家硬超时默认 180 秒（`--limit` 最多 300）。超时、非 2xx、空回答、退出码非 0 都是「没查成／没答上」，不算同意、不换回其他渠道。`ask.mjs` 退出码 0 只表示至少一家答了，必须逐家核对失败项；全部失败退出码 2。
- `ask.mjs` 每次都是新会话，接着聊要把上一轮原话贴进新题面。
- 拍板前让不同厂商族的反方读整份分析：`node $S/second-opinion.mjs --text 材料.md --author-family <族[,族…]>`。magpie 可用时从 GPT、Grok、DeepSeek、SWE 中按顺序挑与作者不同族的一家；失败照实记录再换不同族候选，不因结论有异议换人。型号可用同样的 `--<族>-model` 参数和配置覆盖；按实际型号判断厂商族，不按 recodex/devin 等渠道判断。`--agent haiku` 可显式选 Haiku 反方（仍排除 Claude 作者）。没 magpie 则保持旧候选链。退出码 0 同意、1 有异议、2 没查成（不算同意）。
