# 0008 讨论和第二意见改走本机 Grok 4.7 无头

- 日期：2026-10-02（北京时间，接手会话 09:40 前后）
- 谁拍的：创始人
- 状态：已采纳
- 现状（2026-10-05 回写）：失效。这是 10-02 那台机器 Mirasim 云路不可用时的一时情况，本份自己也前后矛盾（第 2 条「挑错以 Grok 4.7 为首选」，「替代的旧说法」又说排序照旧）；讨论和第二意见的顺序以 0006 为准。
- 关联：docs/design.md 第五节「讨论」、agents/skills/discuss/、docs/decisions/0004-vps-and-rebuild-prereqs.md 第 2 条（Mirasim 探针频率）、specs/517-各家权限同步/

## 原话

> 讨论的 ds 暂不可用，改用无头的 grok4.7

## 决定

1. **讨论（拍板前挑错）和 PR 第二意见**的执行通道改为**本机 `grok` CLI / cursor-cli `grok-4.7-medium` 无头**（`agents/skills/discuss/scripts/` 里的 `grok-cli` profile），不再依赖 Mirasim 云路上的 DeepSeek（dsh）或 Grok（_grok_）。
2. 其他候选（GPT 经 Mirasim codex/gpt-6-luna、Claude 经 reclaude、Kimi 经 Mirasim）保持原样，挑错以 Grok 4.7 为首选。
3. 原因（创始人给、照抄）：「ds 暂不可用」——10-02 凌晨探针实测 Mirasim 的 `dsh/deepseek-flash` 状态 503×7，中继没有这个模型；同一时段拼车 5 小时额度也满，Mirasim 的 codex/kimi 云路同样挂。**候选照的「各家真实端点」要随这台机器状态动态选，不用改排序**（FAMILY_ORDER 不变）。

## 替代的旧说法

**不替**。文档里「优先 GPT → Claude → DeepSeek → Grok → Kimi」的顺序仍成立，只是这台 Mirasim 的 dsh/codex/kimi 云路现在不可用，所以第二意见实际会落到 Grok 上。这是随机器状态的动态选择，不是排序改动。

## 执行怎么做

- 新开的第二意见/讨论：`node $S/second-opinion.mjs --agent grok-cli …`（或 `--models grok`），找的是本机 cursor-cli 装配的 `grok-4.7-medium`。
- 本机 `grok login --device-auth` 于 09-30 完成，凭据在 `~/.grok/auth.json`；HTTP PROXY 走 `127.0.0.1:7890`（Clash 混合口），用户级 `HTTP_PROXY` / `HTTPS_PROXY` 已配好。
- 界面类的题不找 Grok；ui 的仍走 antigravity / Gemini。
- Mirasim 云路回来（dsh 通了、拼车额度回来、codex/kimi 恢复）后，排序照旧；本机这条只是当前可用的那条。

## 没验证的

- Grok 4.7 无头在 Mirasim 里能不能起（`worker.mjs --model grok`）。`docs/PROGRESS.md` 09-30 写过「Grok 在本机修好了」只验了本机 `grok -p "…"` 直连，没验 Mirasim 起 grok 会话。原写「等 #454（本机 Grok 普通模式工人）做时一起验」；#454 已按 0011 第 6 条关成留史，这条改由 #450（本机环境母单）演练时一起验。
