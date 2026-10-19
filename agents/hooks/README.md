# 过程钩子的登记与退役

全量职责、写存读链、原生替代边界与撤层前置见 [hooks 与 Agent 机制审计](../../docs/design/hooks与Agent机制审计.md)。

`plugin-catalog.mjs` 的 `PROCESS_HOOKS` 是过程钩子的现行目录。`plugin-loader.mjs` 在订阅了 `process` 的项目里按目录校准登记：同一脚本只留一条，事件、匹配条件、超时和后台唤醒字段以目录为准；已有登记的 shell / exec 形式和脚本路径保留。没有订阅就清掉受管过程登记，其他钩子保留。

归属不能只看脚本名。加载器只接管完整的 `node` 单脚本命令，路径必须指向传入的本机安装目录、当前项目的 `agents/hooks/`，或对应的 `CLAUDE_PROJECT_DIR` 占位路径。其他目录里的同名脚本、带额外参数或 shell 操作的命令、未知脚本都不接管。

退役时从 `PROCESS_HOOKS` 移除，并把脚本名加进 `RETIRED_PROCESS_HOOKS`。墓碑名单保留，才能在之后开会话或退订时清掉旧登记；只删目录项会留下已经装过的旧钩子。业务能力是否可以撤掉另行核查，不因登记迁移自动退役。

本仓项目设置 `.claude/settings.json` 的目录也要同步更新。核对命令：

```text
pnpm exec vitest run agents/test/rules/plugin-loader.rules.test.ts
pnpm typecheck
```

原生消息链独占投递。main-thread 只检查原生queued_command后的先回规则，并由 background-recovery 读取本会话原生重启通知。恢复提示保留真实任务编号和原任务，兼容旧tick文件只保存backgroundRestartKey；不读创始人原文账、不轮询Mirasim、不标已读。session-id是它和work-watch共用的纯校验。

无人值守身份闸由 `codex-session-source.mjs` 只读当前 Codex 首条 session_meta；原生子代理即使未设 FLEET_WORKER 也拒绝开启或代改父窗口。来源冲突/不完整/超界明确unknown，开场和续轮不借父状态；受配 Mirasim sessions 根链接允许，后代日期/文件链接拒绝。它只作准入，不证明宿主续轮或根消费。

无人值守执行回执由 `continuation-receipts.mjs` 共用，既有 Stop/start/progress 和开关命令传入已经算好的 authority，不另起通知、轮询或看护。现存v1会话/诊断jsonl原位只读保留，位置、内容和哈希不变；新入口用 `continuation-latest.mjs` 写有界v2当前状态，每份小于64KiB。allowed按会话保留最新Stop尝试、一个emitted请求和一组最近关联原证据；prepared不抹旧pending，同代次的迟到尝试拒写，未能证明先后的同floor不同尝试返回ORDER_UNKNOWN。machine/unknown只保留一条可替换的共享诊断，不占父快照、不提供根续轮或消费投影。缺authority默认unknown，缺真实generation不补造、不迁移为成功。

v1/v2共用原128槽、258目录项和256MiB总预算；每个已有v1及其孤立锁按未来2MiB、每份v2按current和next两槽各64KiB预留，替换峰值计入准入。旧writer已有桶仍可按原上限追加，v2后缀使旧writer新桶准入安全拒绝。新写者仅抢一次原目录锁，孤立next、关闭失败或锁替换不清理抢占，明确未知且保留原业务决策。互斥合同仅覆盖遵守共享锁的合作writer；核验时可见身份变化拒绝，提交后身份不符返回IO。路径rename不是CAS，不能保证挡住末次核验后的任意外部替换或回滚，也不声称跨平台掉电安全。`pnpm exec node agents/hooks/unattended.mjs status --receipts` 分列旧历史和最新状态：合法v1恰好4096行仍读得出并保留LIMIT，损坏/锁/读失败不能被新状态洗成成功。只可证明替换次数，漏失量与coverage仍unknown；prepared只表示准备，emitted只表示stdout回调成功，根续轮和结果消费恒unknown。off/过期删除业务窗口后观测返回WINDOW_UNKNOWN，原业务照常。完整边界见 [CLI无人值守接续](../../docs/design/CLI无人值守接续.md)。

session-start只列同血缘旧号实际prompt-log历史，保留时间/字数封顶与来源读取失败诊断。turns缺行不判断丢失，旧seen和steer-shown不参与投递。inbox-watch在退役目录中；inbox-tick和steer-shown也已移除，标准同步清理受管安装目录的旧脚本，不删除用户历史状态。Stop仍保留stop与work-watch，只有work-watch使用asyncRewake。

Codex 的 SessionStart 使用 continuation-start，PostToolUse / Stop 分别使用 continuation-progress-codex / stop-codex 专用入口。登记入口明确 CLI 家族；宿主缺终端环境号时，仅本次可信事件 session_id 可选取来源，直接 on 仍须终端环境号。Claude 共用入口不从 CODEX_HOME 猜 CLI，agent_id 传入共用开场及所有身份闸。prompt-log/work-watch 仍仅按既有 Claude 过程组登记，不新增 Codex 事件。
