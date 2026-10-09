# 0037 各家 AI 的原生钩子由 agents-sync 装；Codex 的信任由同步替本脚本那几条记上

- 日期：2026-10-09（北京时间）
- 谁拍的：创始人放行做法，细节由做 #232 的会话定。原话在下面。
- 状态：采纳。Codex 这一家随 #232 第 1 片落地，其余几家各一片。
- 关联：`packages/agents-sync/src/targets.ts`（`HOOK_TARGETS`、`HOOK_GAPS`）、`packages/agents-sync/src/hooks-codex.ts`、`agents/hooks/vendor-pretool.mjs`、`agents/hooks/pretool-<家>.mjs`、`agents/test/rules/vendor-pretool.rules.test.ts`、`docs/ops.md` 第五节「钩子」
- 取代：无。

## 原话

```
2026-10-09 21:29～21:41（北京时间）

都按照你推荐，不要小修，要改彻底

我要睡觉了，全程你拍板，无人值守，按照最佳方式处理
```

（第一句是对 9 件待拍事项的回复，其中 AI 的推荐是「#232 各家 AI 原生钩子和 #1148 脱敏钩子：都要改标准路径（targets.ts、hooks 的规则测试）。推荐同意，这两个是修漏洞，规矩本身不变」。）

## 决定

1. **拦什么只有一份判断。** 各家的调工具前钩子各有一个入口 `agents/hooks/pretool-<家>.mjs`。入口只做翻译：把那家的输入翻成 Claude Code 的写法，交给 `pretool.mjs` 的 `decide`，再按那家的协议回话。翻不出来就按拦处理。拦什么改在 `decide`，各家自动跟上。
2. **开会话那条，各家都跑同一个 `session-start.mjs`。** 没有开会话事件的那家只登记拦命令那条，`targets.ts` 写明为什么。
3. **装到各家的用户级设置，只动本脚本登记的那几条。** 别人的钩子、别的设置一条不碰，改之前整份备份。
4. **Codex 的信任由同步替本脚本那几条记上，不等人去 `/hooks` 点。** 理由：
   - 法国会话用户、无人值守的会话没人去点。不记上，拦命令那条在这些会话里从来不跑。
   - 信任的来源和 Claude 那份一样，是 origin/main 上的钩子。Claude Code 的用户级钩子本来就不要信任。
   - Codex 自己装插件时，也替插件的钩子记信任（`codex-rs/app-server/src/effective_plugin_change.rs`）。
   - 记的值和人在 `/hooks` 里点信任写的一样。算法照 Codex 源码，2026-10-09 用本机 codex 0.162 核过。
   - 边界：只信任本脚本登记的那几条，别人的钩子不替它信任。人在 `/hooks` 里关掉的（`enabled = false`）、`[features] hooks = false` 整个关掉的，不替人打开，判红报出来。
5. **查不到接口的家不硬凑。** 那一家留在 `HOOK_GAPS`，写明为什么。
