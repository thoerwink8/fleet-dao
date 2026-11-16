# 记忆分拣（#4040）

来源是本机 Claude 项目记忆目录里的每一条（不含索引 `MEMORY.md`）。通用做法写进 magpie-memory（先搜过，不重复已有的派活规程和汇报方式）。本机专属的原文件没动。已经写进仓里规矩的只标注，原文件本轮不删，等指挥官确认。公开仓不抄原话、凭证、内网地址和本机路径。

| 条目 | 去向 | 原因 |
| --- | --- | --- |
| ask-with-options | magpie `m_f673e813797f` | 拍板要给至少两个选项并留自己写；仓里的汇报格式没写这一条 |
| bash-tool-mangles-escapes | magpie `m_29f5779226b7` | 改文件不走会吞转义的 shell，换机器也会碰到 |
| carpool-banned-dont-touch | 留本机 | 某一池的暂停状态，不是通用做法 |
| check-duplicates-across-commanders | magpie `m_30b5ab2db5c0` | 多条指挥会话先查在途 PR；技能里没写全 |
| check-existing-metric-and-worker-decisions | magpie `m_23b9229b228e` | 定口径先查现成的，阈值按新口径重算，工人写回的决定要对照 |
| claude-quota-delegate-grok-agy | 留本机 | 账号、路由组标识和本机路径；派活改名和核对 PR 号已在技能和 magpie，不重复 |
| codegraph-index-fleet-dao | 已写成规矩 | 读代码先查索引在决定 0025；索引文件只在这台机器 |
| desktop-artifact-via-reclaude-no-websocket | 留本机 | 这台桌面端的网关端口和现象 |
| feishu-key-leak-and-no-rotation | 留本机 | 含凭证事故，不进公开仓、不进跨机记忆；挡打印命令行的钩子已在主线 |
| france-remote-query-runaway | magpie `m_7e96264baa69` | 收成「远端查询带超时、不递归搜会话记录」，不写主机和目录 |
| france-ssh-via-hk-wg | 留本机 | 这台机器的跳板和地址 |
| gh-api-job-logs-escape-flag | magpie `m_97ab963fc64f` | 拉任务日志要加允许转义的参数；不写本机代理 |
| gh-host-mirasim-relay-conflict | 留本机 | 这台机器的环境变量和中转配置冲突 |
| github-proxy-clash-7890 | 留本机 | 这台机器连远端的端口和切换顺序 |
| latest-plan-and-lost-context | 已写成规矩 | 现查计划和引导已写在 commander 技能 |
| local-concurrency-cap | 已写成规矩 | 决定 0094，commander 技能按内存和负载派 |
| local-subagent-tiers | 已写成规矩 | 划线已写在通用段和 commander 技能 |
| magpie-local-france-keep-in-sync | magpie `m_4c4834c65278` | 收成「两边网关同步不带删除、登录各登各的」，不写主机和口令位置 |
| mirasim-browser-tool-mode | 留本机 | 这台的浏览器模式、扩展路径和登录限制 |
| mirasim-grok-personal-model-id | 已写成规矩 | 模型名和 route 已写在 mirasim-sessions 技能 |
| mirasim-restart-kills-background | 已写成规矩 | 技能已写：巡检现查，不靠跨轮后台任务 |
| mirasim-server-stall | magpie `m_fcdadfe85470` | 大会话和堆工作树会卡服务；不写本机备份路径 |
| mirasim-steer-delivered-at-turn-end | 已写成规矩 | 技能已改成 prompt 再 stopAndRun，不再靠旧的引导时机 |
| mirasim-ui-cli | 已写成规矩 | 技能已写经 server.cjs 起 ui-cli，版本读 state.json |
| pc-disaster-2026-09-29 | 留本机 | 这台机器的事故和恢复期约束 |
| progress-directive-gotchas | magpie `m_79faf69a1184` | 记引导不带原话会立刻开单；推送前检查扫整棵检出 |
| proxy-log-filename-hosts | 已写成规矩 | 未加引号的通配已经由钩子挡住 |
| reclaude-rewrites-settings-env | magpie `m_b820dcfea918` | 设置文件的 env 会被整段写回，行为改顶层键 |
| sendmessage-forks-workflow-agent | magpie `m_dfaf66d04146` | 给在跑的工作流代理发消息会复制出副本 |
| stale-main-checkout-scripts | magpie `m_783946e298f2` | 主检出停在旧分支时，开单脚本是旧的 |
| ui-done-means-looks-good | magpie `m_e6b3e1db57b6` | 界面完成看样板和观感，不按清单打勾 |
| unattended-run-checkpoints | 已写成规矩 | 落地节奏已写进通用段 |
| vps-upgrade-facts | 留本机 | 某一台机器的升级前提和备份位置，会过期 |
| worktree-session-subagents-share-tree | magpie `m_9912b3c76af7` | 隔离工作树里的子代理共用这一棵树 |

索引 `MEMORY.md` 随条目留在本机，不另存。派活脚本已在 `agents/skills/mirasim-sessions/scripts/dispatch.mjs`（不再放 `_tmp/`），测试在 `agents/test/mirasim-dispatch.test.ts`。心跳清单是 `agents/skills/mirasim-sessions/heartbeat.md`。
