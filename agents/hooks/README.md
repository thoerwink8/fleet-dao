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
