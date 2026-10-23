# 0119 设置的 env 里不钉模型型号：同步把钉死的模型别名算漂移、先备份再删（取代 0092 第 6 条）

- 索引状态：生效
- 日期：2026-10-23（北京时间）
- 谁拍的：创始人 2026-10-23 发现子代理传 `model: "haiku"` 跑的是 claude-haiku-4-5、不是最新的 claude-haiku-5-5，要求查根因、解决根因（原话在私有处）；怎么守由本机会话按引导 20261015054500 拍。改标准（`packages/agents-sync/**`），按决定 0097 自己落、事后报。单 #3676。
- 状态：采纳，引入它的 PR 合并即生效。
- 取代：决定 0092 第 6 条「`env` 里别的改模型的键不是同步工具写的，不碰」。0092 其余各条不变（启动命令是 reclaude 的桌面机照旧不写 `CLAUDE_CODE_SUBAGENT_MODEL`）。
- 关联：`packages/agents-sync/src/model-pins.ts`、`packages/agents-sync/test/model-pins.test.ts`、`packages/agents-sync/src/cli.ts`；决定 0034、0087、0092；`docs/reclaude-in-mirasim.md`「0092 那条坑」；`agents/subagents/README.md`。

## 背景

2026-09-02 为了躲中转站，有会话往 `~/.claude/settings.json` 和 reclaude 账号目录 `~/.rec/claude/accounts/<号>/config/settings.json` 的 `env` 里手写了三个钉死的别名：`ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001`、`ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8`、`ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5`。同步按 0092 第 6 条故意不碰这些键，5.5 出来后别名还钉在旧型号上：子代理按别名派活（`model: "haiku"`）悄悄跑旧型号，没人察觉。同样这几个键还会让 Mirasim 判 claude 被拦截、不给跟随全局的会话注入平台网关（0092 背景一节）。

2026-10-23 本机两份文件手工删掉这三个键后实测：`reclaude -p --model haiku` 回的 `modelUsage` 是 claude-haiku-5-5。

## 决定

1. **settings 的 `env` 里不钉模型型号**：`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_FABLE_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL` 这五个键不许出现。别名交给 Claude Code 自己解析到当前最新型号；子代理要钉型号，只在三个角色定义（`Explore`、`general-purpose`、`Plan`，0087）里写完整 id。
2. **同步工具守住**：扫两处——`~/.claude/settings.json`，和 reclaude 各账号目录 `~/.rec/claude/accounts/*/config/settings.json`（reclaude 起的 Claude 读这份）。
   - `--check`：见到就报漂移，一行说清哪个文件、哪个键、钉的是什么。
   - 正常同步：先把原文件备份到 `~/.fleet-dao/backups/<时间>/`，再删这几个键，报一行删了什么、备份在哪。`env` 里别的变量、文件里别的内容一个不碰。
   - 哪一份读不了、不是 JSON、`env` 不是对象：报「没查成」、不动它，接着扫别的，不中断同步。
   - `--user`（替法国的用户同步）同样扫和删：同步那时已降权成那个用户，写回的文件归属不变。
3. **子代理默认模型 `CLAUDE_CODE_SUBAGENT_MODEL` 不归这条**：照旧由 `permissions.ts` 按 0034、0092 管。

## 没做的

- 没给这五个键留「机器上自己设的保留」的口子：它们的唯一作用就是把别名钉死，留着迟早过时；真要临时换型号，在会话里显式传完整 id。
