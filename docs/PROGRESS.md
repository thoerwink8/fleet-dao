# 进度（本机恢复与重做前置）

> 一行一条、带日期和对应提交。规矩在 `AGENTS.md` 通用段「进度也要落盘」。

## 2026-09-30 / 10-01（本机，指挥官会话）

- **Grok 在本机修好了**（2026-09-30）。原因：C 盘事故把 `~/.grok/auth.json` 冲掉，且 Grok 只认代理环境变量、不读 Windows 系统代理。做法：1) `grok login --device-auth` 重新登录（创始人本人在浏览器确认）；2) 给这台机器的用户级环境加 `HTTP_PROXY` / `HTTPS_PROXY = http://127.0.0.1:7890`（Clash 混合口），`NO_PROXY` 原有值不动。**法国 VPS 直连能通，不需要这段配置。** 验证：只带用户级环境变量跑 `grok -p …` 返回 OK，模型 `grok-4.7`。没验证的：Mirasim 里新开 Grok 会话（要人在界面上点）。
- **Mirasim 的「平台 / 自有」两个额度来源按钮：机制没坏，是两边都没配好。** 查到的：`~/.mirasim/plugin-index/<机器>.json` 的 `routes` 按**会话**记路由，本机 262 条里 `cloud` 233 / `local` 29；本会话被钉在 `cloud`，所以每次调用都进 `relay.mirasim.ai`（`~/.mirasim/traffic/<会话>/index-0.ndjson` 494 行全部 `viaRelay=true`、`accountId=null`）。「自有」那条路要求「本机有该智能体的账号凭据」，`setting.json` 的 `agent_accounts` 是空的。
- **reclaude 设备身份对不上：重启没用，但实测不影响干活（收尾）。** `reclaude status` 报 `device signing key fingerprint mismatch (disk=06cbad…, device.json=dd8583…)`，只影响「账号同步」（额度上报），**不影响发请求**：2026-10-01 00:56 重启守护进程（pid 55760 → 19376）后仍在报，但当场实测 `reclaude -p "…"` 返回 OK，退出码 0。结论：**不修**——它是上报链路的毛病，修它要动 reclaude 的账号状态（可能要重新 `reclaude login`），风险大于收益。
- **启动器没问题。** `docs/reclaude-in-mirasim.md` 那套在跑：`%LOCALAPPDATA%\reclaude-mirasim\launch.log` 里 `route=local（自有） settingsStripped=true` 出现过 27 次（最近 09-30 15:48），`route=cloud（平台），原样放行` 2 次（最近 09-30 23:43，即本会话被切到平台那次）。Clash 里**没有**需要撤的 `Mirasim.exe → reclaude` 进程规则，只有 `reclaude.ai → DIRECT` 域名规则。
- **Grok 代理那段会影响 reclude 吗：会。** 用户级 `HTTPS_PROXY` 会让 `reclaude` 守护进程的重连尝试也经 Clash；守护进程的 `tunnel error` / `intercept sync` 超时从 09-30 22:36 前后开始变密。修完设备身份后如果还刷错误，先试撤掉这两行（`[Environment]::SetEnvironmentVariable('HTTPS_PROXY',$null,'User')`）。
- **待办**：① 要在 Mirasim 里用「自有」的会话，把路由从 `cloud` 切回 `local`（**只对新起的 claude 进程生效**，`docs/reclaude-in-mirasim.md` 第 5 节）；② 轮换我在查询时打进对话的 `ANTHROPIC_AUTH_TOKEN` 前缀（会话令牌，短效）。原来排第一的「创始人跑 `reclaude stop && reclaude`」已被实测推翻（见上面 reclaude 那条），划掉。
- **主线没动**：这一天的分析（GPT 会话做了什么、原计划现状、GitHub 单与 PR、本机在途工作树、需求核读进度）跑在子任务里，结论出来后写进 `specs/509-需求梳理/` 和这张表。计划本体仍是 `docs/goals.md`（三段一条龙 + 副手 + 删除清单 + 换法国 VPS 前先在本机演练台调优）。

## 2026-10-01 凌晨（D0 文档对齐，本机指挥官会话）

- **Grok 修好之后本机这一轮的产出进了主线/开了 PR**：#523（进度落盘）、#524（决定 0006 + goals 对齐）已合；#525（执行计划草案）、#526（discuss 按写手家族选候选，**改标准，等创始人同意**）CI 全绿；#528（12 张已关单的历史需求加替代指针，19 份文档）、#529（design.md 头部加「重做中」横幅）刚开。
- **必跑检查实测出的坑**：`docs/goals.md` 不在 `doc-pointers.ts` 的 `ALIASES` 表里，所以「`docs/goals.md` 第六节」「`docs/goals.md` 的『要删的，和怎么删』一节」这两种写法**都会被判红**（第二种被当成指本文件的一节），只有不带节号的 `` `docs/goals.md` `` 才过。已实测（223 份文档、0 条问题）。这是替代指针一律不写节号的原因。
- **#475、#481 两张卡死的 PR 诊断完了，等创始人拍**：#475（帅位/认领简化）想做的事主线已经做了（`agents/skills/commander/SKILL.md:10` 现在写着「不设座位、不在库里认领」），而且它要改的 `commander-seat/SKILL.md` 主线已删；#481（删敏感值名单）当时写的「前提被 09-30 那条拍板顶掉、方向比主线还松」**是错的，见下一段的更正**。
- **D0 六份草稿 + 三份独立复核都出来了**（`_tmp/0930/d0-*.md`）。复核一致判「改了再用」，主要问题是：替代指针模板会判红（已改）、#509 正文数字要与 26/33 对齐、未挂里程碑那份有七处账对不上（含一处和决定 0006 相反，不能写进子单验收）。
- **待办**：① 把 #509 的 12 张子单里现在能开的 3 张开出去（`#509` 下现在 0 张）；② #475/#481 等拍；③ #526 等一句「同意」。
- **本轮已合**：#528（12 张历史需求加替代指针，19 份文档）、#529（design.md 头部「重做中」横幅）。#525（执行计划草案）在等创始人拍八件；#526（改标准）在等一句「同意」。
- ~~卡住的一件事：#509 正文更新被权限分类器拦下~~ 不用改了，见下一段。

## 2026-10-01 凌晨（创始人拍了四件之后）

- **创始人原话**（01:35 前后，北京时间）：「1同意 / 2.同意 / 3.我放行，按道理最新的auto权限应该自动放行？是怎么原因导致的不行？ / 4.可以开」。
- **#526 合了**（改标准，正文贴了原话和时间）。**#475 关了**（被删除计划整个替掉，分支留着）。
- **#481 先没关，因为我之前说错了**：我跟创始人说它「前提被 09-30 那条拍板顶掉」。实际上 09-30 创始人删的是通用段「密钥、令牌、口令的值不进对话」那条底线（#515，原话「2，并且改底线」）；本仓段那句「账号、组织编号、邮箱、IP 这类标识不写进公开仓（卫生检查按这个查）」是那次 AI 改文档时自己搬过去的，不是创始人拍的。至今最新的拍板仍是 09-28 傍晚「1 不在乎：名单整个删掉」（`specs/169-Fusion形态/需求.md`），#481 正是照它做的。已在对话里更正，等创始人定：拉主线接着用、当 #532 的实现（推荐），还是关掉重做。
- **#509 第一批子单开了**：#530（删本机进度页、帅位栏写入和对账开单，本机做）、#531（删帅位座位里人的那半，取代 #446）、#532（删敏感值名单）；按 `docs/goals.md` 附录把 #443（带着 #446）和 #250 挂到了 #509 下面；三张的需求文档和母单的更新在 #533。
- **#509 的单子正文不用改**：单子上只留原话、AI 理解和需求文档路径，`<本单号>` 是故意的占位（`packages/core/src/criteria.ts` 认它）；数字、漂移、版本名这些更新全进 `specs/509-需求梳理/需求.md`（#533）。之前想整个覆盖单子正文是走错了地方，分类器拦得对。
- **auto 模式为什么拦**（查的是 Claude Code 文档 auto-mode-config 一页）：进 auto 模式时，能跑任意代码的宽规则（`Bash`、`PowerShell`、`Bash(node:*)`、`Bash(python:*)` 这类）会被暂时撤掉、交给分类器判，窄规则（`Bash(gh:*)`）照旧直接放；那条命令前面带了 `cd`、`timeout`，配不上 `Bash(gh:*)`，于是进了分类器。分类器没给规则名，最可能是把「用一份 136 行的文件整个覆盖一张已有单子的正文」判成了用户没明确要的覆盖。用户在对话里说的话分类器看得到，但要具体到动作本身才算数。根治办法是 `~/.claude/settings.json` 的 `autoMode`（`environment`、`allow`，用自然语言写；只认用户级，项目里的 `.claude/settings.json` 不认）。仓里的权限清单 `agents/config/claude-permissions.json` 和同步工具现在不管 `autoMode`；要加是改标准，等创始人拍。
- **顺带发现**：本机的 `pretool.mjs` 钩子把 `node -e` 字符串里出现的「reclaude login」几个字当成要执行的切号命令拦了。09-28 傍晚拍过这两条小拦「改成只认命令本身、不认正文里的字样」，没做到；归到删读密钥钩子那张子单一起改（钩子里的这两条小拦留，只是改判法）。

## 2026-10-01 晚上（法国 root 打通、保险箱换钥匙）

- **法国 root 通了，不用 VNC 了**。路：Contabo 面板里 `Reset credentials → Password` 重设 root 口令——**这条会重启那台**（约 3 分钟，Contabo 的文档写的，实测也是），重启后 18:22 起来；然后 TightVNC 连面板 `VNC` 那行给出的地址（VNC 密码在那行的锁形图标按钮 `title="VNC Control"` 里设），在控制台里 `root` + 新口令登进去，把 `workstation/ssh/fleet_login.pub` 追加进 `/root/.ssh/authorized_keys`（600）。本机 `ssh contabo-jump whoami` → `root`、`hostname` → 那台的短名。**`hk-jump` 这个别名本机没配**（试了报 `Could not resolve hostname`），要走香港跳板得先配。
  - 地址、实例号不写进公开仓，要连的时候从 Contabo 面板或保险箱取。
  - 踩过的坑：Contabo 的「Add and Store SSH-Key」存在**账号**上，不会下发到正在跑的实例，对这台没用；VNC 密码和 Linux root 口令是**两把不同的钥匙**，VNC 密码只开屏幕。
  - **两串口令进了对话**（VNC 密码、新 root 口令），要找时间在面板里换掉。
- **保险箱换了钥匙**（`fleet-dao-vault` `3ae943d` + `f4dc486`）。旧钥匙（本机 `.fleet-dao/vault-key.txt`、仓里 `workstation/age-identity.txt`）随 09-29 那次 C 盘被清没了，两台服务器上明文都还在（法国 26+2 个、香港 5+2 个），所以照新写的 `rekey.sh` 重生成一把、35 个 `.age` 全部按新公钥重加密。**验证**：`verify-rekey.sh` 报「解开 35 个，解不开 0 个」「新公钥加密 → 新钥匙解密，通了」。
  - 顺手补进仓三样一直没进仓的：`rekey.sh`（换钥匙）、`verify-rekey.sh`（只读核对）、`workstation/ssh/config.sh`（配 ssh 别名）——最后一个还没提交。
  - README 两处按 10-01 那条拍板改对：钥匙正本**在私有仓里**（只靠私有仓 + GitHub 账号保护），本机那份是方便副本。
- **法国那个 OOM 是旧账，不是现在的病**。查清了：`journalctl -k -b -1` 显示被杀的是 **09-25 那天的 4 次**，`oom_memcg=/fleet.slice/fleet-agents.slice/fleet-agent-e2e-*-mem.scope`——是 09-25 那次演练起的**临时 e2e 会话**（`python3`，UID 994）把自己那格内存撑爆了，不是常驻服务。重启后（18:22 起）`free -h` 是 11Gi 里用 1.0Gi、available 10Gi，一次没再发生。**结论：不修**；那种 `fleet-agent-e2e-*` 的临时 scope 现在也不在跑了。
- **待办**：① 轮换进对话的那两串口令；② 保险箱 README 里「服务器上真正要紧的密钥也换掉」（GitHub 机器人私钥、飞书 App Secret、备份口令）那句，要不要现在做——**这是另一件事，还没动**；③ 新机器一键配置那三个待定项（第一版做到哪、盘符、代理归谁管）还没起草。

## 2026-10-01 深夜（保险箱收窄、跳板别名、换钥匙收尾）

- **创始人当晚那句「韶关 3 号楼这一种根本就不需要存进我们的保险箱里」是纠错，照办**：下午那条判准写「丢了以后除了创始人脑子里别处还有没有」，却把别人家的现场凭据算进了「放」那一栏——跟判准自己矛盾（那种丢了跟现场要一份就有）。收窄成「我们自己有、丢了别处再也没有」：自建 VPS 订阅、`france/`、`hk/` 里的配置和密钥留下，现场凭据撤掉。
  - 私有仓：删 `workstation/sites/`，`workstation/README.md` 重写（`48f7deb`，已 push）。
  - fleet-dao：`agents/config/claude-permissions.json` 的 `autoMode.allow` 删掉 `workstation/sites/`、`docs/agents-permissions.md` 同步改、`docs/decisions/0005` 补「当晚再收窄」、README 改 → **PR #552**（改标准，正文贴了原话，CI 全绿、已挂自动合并）。
- **ssh 别名补 `hk-jump`**（香港，和 `myserver` 等价、给跳板用）。实测四条路都通：本机直连法国、直连香港、`ssh -J hk-jump contabo-jump` 经香港跳法国、法国→香港隧道对端 22 也通。脚本在私有仓 `workstation/ssh/config.sh`（`c986007`）。
- **换钥匙那件事彻底收尾**：「服务器上的密钥也要换」那句改成条件句——**丢了**不用换（09-29 那次就是丢了），**怀疑泄露**才换。创始人当晚拍「口令就不需要换了」，服务器上一个密钥没动。`rekey.sh`、`verify-rekey.sh` 一并进仓（`48f7deb` 之前那次提交）。
- **待办**：① 新机器一键配置按「以我的标准为主」起草（创始人当晚授权），三项待定我自己定、草案出来给他看一眼；② 那台 Mac 的 `.env` 等的是它自己现场那套凭据，现在知道**不走保险箱**了，得由创始人或现场给。

## 2026-10-02 补记（当晚的收尾）

- **#552 已合**（12:51，改标准，CI 全绿含 deploy）。合进去的是：保险箱收窄到只放「我们自己有、丢了别处再也没有」的凭据；`workstation/sites/` 从私有仓删掉。
- **CI 那两处红也修了**（同 PR 第二个提交）：biome 要求 `additionalDirectories` 收成一行；`packages/agents-sync/test/permissions.test.ts` 里原来断言放行**必须**含 `workstation/sites/`，跟着改成断言**不许**含。本地 279 条过。
- **那台 Mac 的 `.env` 怎么办（结论）**：`GRAB_*`（平台账号）、`SRC_DB_*`（现场库账号）是**别人家的**，按新规矩**不走保险箱**，由创始人或现场给；`JEV_API_KEY` 是**我们自己**的（TypeSafe System One，保险箱 `france/etc/fleet-dao/typesafe.key.age` 里有），可以从保险箱取。

## 2026-10-02 深夜（流程重做：方案定稿、清单清理完）

**起因**：创始人 2026-10-02 说「必须重做，因为那套流程太复杂，而且既不快又不省，也不一定好」。一整轮拷问（`grill-me`）后定出三段一条龙。

**落盘的**（`specs/509-需求梳理/`）：
- `流程重做方案.md` —— 三段、分档、验收、路由两层、留什么删什么、验收标准
- `执行计划.md` —— 六步顺序、怎么并行、没验证的

**清理做完**（第 0 步）：
- 开 `v3 三段一条龙` 里程碑（`#10`）；关掉 `v1 Fusion 接活`（`#8`，关了 239 张）、`v2 引擎打磨`（`#9`）
- 18 张还有效的单移进 v3（`#489 #454 #453 #452 #450 #446 #443 #440 #380 #345 #323 #242 #227 #216 #194 #157 #76 #59`）
- 13 张 Fusion 零件**关掉留史**（评论写明被 #509 取代，不删）：`#252 #249 #251 #215 #250 #277 #419 #257 #300 #193 #191 #247 #284`
- `#443` 合进 `#509`；四个母单开出并挂上：`#553` 对题 / `#554` 动手 / `#555` 验收 / `#556` 清理

**待创始人拍**（醒了回）：
1. Mirasim 那三条路由（Opus / GPT-Luna / Kimi）现在打开吗？（`mirasim-relay` 池现在只开 deepseek-flash）
2. 探针频率（现在 2 小时真探一次、探通也扣额度）要不要降到 6 小时？

**在验**：实测 Mirasim 能不能真起无头会话（后台 agent 在跑，结论写 `_tmp/mirasim-headless-实测.md`）。

**注意两处**：
- 代理口 59822 是坏的，用 Clash 的 7890（`export http_proxy=http://127.0.0.1:7890`）
- `pnpm issue:new --specs` 的用法：正文开头要先写创始人原话 + AI 理解，正文要有 `## 怎么算做完`；`--specs` 传短名，脚本会拼成 `specs/<号>-<短名>`

## 2026-10-02 深夜（worktree 清理、救回决定 0006）

- **worktree：29 棵 → 1 棵**（创始人拍的「不要积累」，理由是他自己的实战教训：Mirasim 会随 worktree 和会话变多越来越卡）。清之前**逐棵查了「有没有没进主线的提交、没提交的改动」**——这是仓里的规矩，删数据要人拍。
  - 清掉 23 棵干净的。
  - **救回一个真东西**：`.claude/worktrees/decision-align` 里躺着 `docs/decisions/0006-discussion-model-order.md`——创始人 09-30 拍的「讨论与独立 Review 的模型顺序 GPT→Claude→DeepSeek→Grok→Kimi、都走无头、约 30 秒」，**从没进过主线**。写它的那个会话收了尾就没人管这棵树，内容一直躺在里面。已一字未改落进主线（`d22fda5c`）。
  - 其余 3 棵的内容确认都在主线上：`537-resolve` 那 3 个提交 → 主线 `e56bd4a9`；`second-opinion` 那个 ci-plan 修复 → 主线 `packages/conventions/src/ci-plan.ts:91`。
- **教训**：`worktree-sweep.ts` 现在只认「需求工作流和子任务工作流」，**认不出讨论 skill 的临时树**，所以它们永远攒着。创始人拍了要扩，归到 #556。
- **顺带**：清了本机 `_route-probe` 之外的残留后，本机 `git worktree list` 只剩主检出。

**在跑**：三个后台 agent 探 Mirasim 全部 15 个模型（claude 7、codex 6、dsh 1、kimi 1），结果写 `_tmp/probe-{claude,codex,dsh-kimi}.md`。
