# packages/omp-bridge：统一 Agent 执行桥（方案 2）

决定 0125 方案 2 的核心执行与优化层：
- **底层总控由 Rust 守护内核（`crates/`）掌管**；
- **左膀（Claude 订阅池）**：只走 `reclaude` 官方客户端本体常驻双向流（`--input-format stream-json --output-format stream-json`），**绝不用 HTTP 反代**，严守 `一号一环境` 与 `non_cc_client` 零上报防封铁律；
- **右臂（开放 API 与多模型渠道）**：走小而美的 `pi`（omp）常驻流，直连 `recodex`、`kiro`、`commoncode/opencode`（DeepSeek 等）、`devin`、`grok`、`antigravity` 及各类中转站。

## 模块与不变量

- `src/matrix.ts`：**四维路由矩阵（工种 Role × 渠道 Channel × 模型 Model × 账号池 Account）**。严格区分 `native-reclaude-stream`（只调官方本体、Magpie 仅用只读 `rck_` 接口看 5h 美元窗）与 `pi-api-stream`（经本地回环网关调 API，真密钥不出内核）。
- `src/prompt-compiler.ts`：**模型专属提示词编译器与战绩自进化闭环（Prompt Overlay & Auto-Evolution）**。按工种底座 + 模型族脾气补丁（Claude / DeepSeek / GPT-Codex / Grok / Gemini / Swe-2）+ Scout 预热切片拼装；同类失败满 3 次自动触发反模式护栏提炼与 Wilson 置信度验证。
- `src/ysk-watcher.ts`：**仿 Claude Code `you-should-know`（YSK）旁路盯梢插件**。默认绑定免费的 `devin/swe-2`，只看不改，在主 Agent 每次文件改动后异步对比原需求与 `git diff`，抓出「顺手改了已上线文案/导航/接口」等越界副作用，输出 `✦ Heads up · 主 agent` 并支持自动 `steer` 纠偏。
- `src/token-compactor.ts`：**省 Token 三板斧**：① Scout 代码行号区间预切片（免去主模型盲搜）；② 测试/构建大输出智能折叠（全绿压成 1 行，失败只留核心栈）；③ 跨轮次历史工具输出无损脱水。
- `src/blackboard.ts`：**跨会话 Actor 通信与共享黑板**。提供 `steer`（下行实时引导）、`publishFact`（同波次接口契约变更广播）、`handoff`（跨模型热切与跨阶段交接胶囊）。
- `src/trust-funnel.ts`：**四道递进式可信度验收漏斗**（YSK 实时纠偏 → 0 Token 机械门禁 → 异族盲审 Cold Verify → Wilson 战绩自适应放行）与 **本地波次合流（整单一次出 PR）**。
- `src/pi-extension.ts`：可直接挂进 `~/.pi/agent/extensions/` 的轻量级 `pi` 扩展入口。

## 测试

- `npx vitest run packages/omp-bridge`
