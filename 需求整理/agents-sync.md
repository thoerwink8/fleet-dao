# agents-sync：把规矩、技能、钩子同步到每台机器上各家 AI（业务说明）

> 一句话：仓里 `AGENTS.md` 上半段（通用段）、`agents/skills/`（自研技能）、`agents/skills-vendor/`（第三方技能，锁文件核过）、`agents/hooks/`（钩子）——**开会话时自己跟上主线**，写进这台机器上每家 AI 的全局说明、技能目录、钩子设置和配置开关；查得出漂移、撤得掉旧仓留下的东西；只动自己装过的，别的一概不碰。
> 出处：`packages/agents-sync/package.json` 说明；`src/` 各文件头注释（16 个文件 + #507 新增的 `vendor.ts`、`vendor-cli.ts`、`vendor-main.ts`）；`test/`（16 + 2 个文件）；`docs/ops.md` 第五节、第九节；`agents/skills-vendor/README.md`（第三方技能的规则）。

## 一、干什么、不干什么

- **模式**：`--check`（只查，不写）、`--apply`（写完照查一遍）、`--retire-old --old-repo <旧仓>`（撤旧仓留下的链接和两个旧子代理）、`--user <用户>`（root 替别的用户写，法国装机用）；`agents-vendor verify | diff | rehash`（手动升级第三方技能用）。
- **写到哪**（`targets.ts`，每个落点 Windows、Linux 各一列，相对家目录；依据是各家官方文档或源码，**改之前先查那一家现在的读法，别凭印象加落点**）：Claude（`~/.claude/CLAUDE.md`、`~/.claude/skills`、`~/.claude/settings.json`）、Codex/pi/Kimi Code/dsh（`~/.codex/AGENTS.md`、`~/.pi/agent/AGENTS.md`、`~/.kimi-code/AGENTS.md`、`~/.dsh/AGENTS.md`、`~/.agents/skills`）、Antigravity（`~/.gemini/GEMINI.md`、`~/.gemini/config/skills`）、Grok（借道读 `~/.claude/*`；另有 `~/.grok/config.toml` 的两个开关：目录信任、反问选择题）、Devin（`AppData\Roaming` / `~/.config`）；**环境变量改过位置的（`CODEX_HOME`、`PI_CODING_AGENT_DIR`、`KIMI_CODE_HOME`、`DSH_HOME`、`CLAUDE_CONFIG_DIR`……）一概不跟**——跟了就会随调用者的环境写到别处（测试拿临时家目录跑也会被带到真家目录去）。
- **不干**：编辑 `AGENTS.md` 内容、发明新规矩；动别人的钩子、别的设置、别的技能。

## 二、业务规则（每条标出处）

**A. 通用段**（`block.ts`、`sync.ts`，`rules.test.ts`、`block.test.ts`）

1. 仓里 `AGENTS.md` 和各家全局文件用**同一对标记**：标记之间（含两行标记）是受管的一块、标记外的内容一个字节都不动；只认整行一模一样的标记（行首行尾空白和 `\r` 不算）；两个开始标记、只有开始、结束在前都算不成对（写不动它、查判漂移）；换块时**保持文件原来的换行**（CRLF 文件换进去的块也用 CRLF）；`\r` 不算漂移。改标记文字要连仓里 `AGENTS.md` 一起改（已写到各家文件里的旧标记新标记认不出，会被当成「没有受管块」再接管一次并先备份）。——`block.ts`。
2. **第一次接管（文件里没有标记）先整份备份**（`~/.fleet-dao/backups/<时间>/`，照原来相对家目录的路径摆；链接没法拷就记进 `links.json`；备份**不放进各家会扫的目录**——放在 `~/.claude` 底下 Claude 会把备份的旧规矩也读进去），输出写明原文件几行、备份在哪，再整份换成受管块；已有受管块不再备份；第二遍零改动（一个字节不变）。——`rules.test.ts`、`backup.ts`。
3. **没装的那家不算绿**：按可执行文件在不在 `PATH`（家目录 `.local/bin` 也算——reclaude、claude 的原生安装放那儿；各家另登记的 `homeDirs` 也算——grok 官方安装在 `~/.grok/bin` 不进 `PATH`）判；**不看配置目录在不在**（法国的会话用户装了 codex、pi 家里却还没有 `~/.codex`、`~/.pi`，照样要写）；没装的逐项列成「没装、跳过」，不算进「一致」、不影响退出码、那家的文件一个字不写；只装了 Grok：照样写 `~/.claude/CLAUDE.md`（Grok 借道读它）。`~/.codex/AGENTS.override.md` 在：codex 读不到这份通用段，判漂移。——`detect.ts`；`rules.test.ts`、`detect.test.ts`。

**B. 技能**（`sync.ts`、`manifest.ts`、`vendor.ts`，`skills.test.ts`、`vendor.test.ts`）

4. 拷进装了的那几家的技能目录并记进**清单**（`~/.fleet-dao/agents-sync.json`）：查判一致、第二遍零改动；装上的被人删了 → 缺失、再写补回来；被人改了 → 漂移、再写换回仓里的版本；只差 `\r` 不算漂移（`* text=auto eol=lf`、Windows 检出是 CRLF）；没装的那家不建它的目录。——`skills.test.ts`。
5. **只有清单里记着的才更新或撤掉，别的一律不碰**（Mirasim 插件链进来的、claude.ai 同步来的、旧仓链进来的）：同名的真目录（内容不同）写不动它、报没做成、查判漂移；同名的是链接：不动链接也不动它指的东西；清单里没记的，仓里删了也不撤；**同名目录内容一字不差但清单里没记：不接管、判红**（接管了，仓里删掉它时会连这个不归它管的目录一起撤）。**清单读不懂就是读不懂，不当成空的**（当成空的，仓里删掉的技能就永远撤不掉、检查照样说没事）：清单不是 JSON → 没查成（退出码 2）、一个技能都不动；名字带路径（`../../.ssh`、`a/b`、`..`）→ 读不懂、一个都不撤（不许顺着名字删到技能目录外面）；形状不对一样读不懂。——`skills.test.ts`；`manifest.ts`。
6. 仓里删掉的技能：从每个目录撤掉、清单跟着改；仓里的 `agents/skills/` **删空了：装过的照样撤**；**目录整个不在是另一回事：判读不到、一个不撤**（检出不全时会把装过的都撤掉，`cli.test.ts`）；空的且清单里也没记：报「没有技能可分发」、不算失败、不建清单。——同上。
7. **第三方技能层**（#507，`agents/skills-vendor/` + `vendor.lock.json` + `vendor.ts`）：分发前**照锁文件逐个文件核 sha256（只把 CRLF 换成 LF 再算，单独的 `\r` 算内容、第二意见 #507 第 1 轮指出的绕过口）**，**核不过整体不发**（自研的规矩也一起停，退出码 2）；名字和自研技能撞车直接报错；来源必须是 `https://github.com/…` 加 40 位提交号（分支名不行）；许可证只认 MIT、Apache-2.0；每个技能要有 `SKILL.md`（frontmatter 的 `name` 和目录名一致）和许可证文件；路径不许跳出去、目录里不许有链接、没登记的目录不许有；`rejected` 清单里的技能（`requesting-code-review`、`skill-creator`）不许同时出现在 `skills` 里；升级只能手动：`agents-vendor diff` 出差异、`rehash` 重写锁、走「碰安全」先审后合。——`vendor.ts`；`vendor.test.ts`、`vendor-repo.test.ts`；`agents/skills-vendor/README.md`。
8. 各家 AI 从哪读技能的路径表两平台逐列对得上（Windows 一列用 `\`、Linux 一列用 `/`）；`deploy/lib/snapshot.sh` 的 `ours` 段另抄了一份落点（故意不借这边的代码，是另一套判据），这边加了落点那边没跟上「两遍之间 diff 为空」就查不到新落点被改过——`snapshot-list.test.ts` 当场红。——`detect.test.ts`、`snapshot-list.test.ts`。

**C. 钩子**（`hooks.ts`，`hooks.test.ts` 26 条）

9. `agents/hooks/` 下的脚本整份拷进 `~/.fleet-dao/hooks/`，再在各家设置文件（`HOOK_TARGETS`）里登记三条（开会话 `SessionStart`、调工具前 `PreToolUse`、`Stop`）；**设置文件里只动本脚本管的那几条**（命令指向 `~/.fleet-dao/hooks/` 下的脚本，或以前手装在 `fleet-guard` 目录的两条，接管时换掉），别的钩子、别的设置一条不碰，同一个组里还有别人的钩子只拿掉本脚本那一条；写回去保持原换行；写之前先备份。——`hooks.ts`；`hooks.test.ts`。
10. **设置文件读不懂（不是 JSON、整份是数组、`hooks` 不是对象）就不动、报没做成——不当成空的重写**；`disableAllHooks` 开着：登记照写但报没做成、要人看；登记得不对（`timeout` 被改、同一组登记了两遍）：查判漂移、再写每组只留一条对的；脚本被人改了：漂移、换回仓里的；仓里没有 `agents/hooks/`（检出太旧）：脚本查判没查成、登记照查（缺失）、写报没做成、**不登记指向空处的命令**；仓里的 `agents/hooks/` 少了登记要用的脚本：不登记。——同上。
11. **调工具前那条挂在哪些工具上**：Claude 组 `Bash`、`PowerShell`、`Read`、`Grep`（只含字母和 `|`，逐个全等比）；Devin 组 `exec`、`read`、`grep`（锚定，不会连 `notebook_read`、`read_subagent`、`mcp_read_resource`、MCP 工具一起匹配上）；登记的每个工具名仓里的 `pretool.mjs` 都要认得。**替别的用户写（`--user`，法国装机）时开会话那条不登记**（它要在这个用户自己能拉、能写的检出里快进、同步），调工具前、`Stop` 那两条照装（法国会话用户家里就有 reclaude 的设备密钥，借道读这份设置的 Grok、Cursor 起的会话也要拦）。没装读这份设置的那几家：跳过、逐家说为什么没装钩子（Codex 有钩子但每条都要人在 Codex 里用 `/hooks` 审过信任才跑，还没接；Kimi Code 的钩子是 TOML；Antigravity 的钩子是另一套；pi 没有配置式钩子；dsh 没有自带全局钩子——#232 开着）。——同上；`report` 输出里逐家列出。
12. **开会话钩子**（`session-hook.test.ts`）：开会话时先取远端、把 `fleet-dao` 检出快进到主线、用检出里的 `agents-sync` 同步，规矩跟上主线；**主线上的原件坏了同步不成：会话里有明确提醒**（没查成，不静默）；钩子没装（登记被人删了）：`--check` 判红、`--apply` 补回来。——`session-hook.test.ts`；本次 SessionStart 的提醒「规矩同步没查成：记下的检出不是 git 仓（退出码 3221225781）」就是这一条在起作用。

**D. 同步位置与全局设置**（`position.ts`、`git-excludes.ts`、`tool-config.ts`、`lock.ts`）

13. **同步位置**（`~/.fleet-dao/synced.json`）：`repo` ＝ 同步用的检出（linked worktree 记它的主工作树；每次从 git 检出 `--apply` 都记，开会话钩子按它找检出，就算这次有没做成的项下次开会话也能接着同步、接着报）；`synced` ＝ 上次整次同步没有 ✗、没有没查成时的提交（**只在变了的时候写**，第二遍零改动）；**落后主线几个按本机上次取到的 `origin/main` 算，查的时候不出网**（开会话钩子先取远端再同步）；从没合进主线的分支同步：记下但判「不在主线上」；不是 git 检出：不记、不查、写明为什么（不算错）；没有 `origin/main`：落后几个查不了、报没查成；记录坏了：查判没查成、写的时候重写；**git 的事都在换身份之前问好**（换过去之后未必读得到仓，git 也会因为仓的属主不是自己而拒读）。——`position.test.ts`。
14. **全局 git 忽略 `_tmp/`**：加进这台机器的 `core.excludesFile`（通用段「截图、日志放 `_tmp/`」的最后一道网，哪怕某个仓自己的 `.gitignore` 漏写）；**不抢用户已在用的文件**：`core.excludesFile` 没设过才新建 `~/.fleet-dao/gitignore_global` 并指过去；已指到别的文件就在那份文件里接管标记圈起来的一小块、其余原样留着；被人手改过受管块判漂移、写只换那一块并备份原文件；指针悬空判缺失、照原路径建；标记本身坏了（两个开始标记）不猜、不动文件；`.gitconfig` 语法本身是坏的：查报没查成（**不能因为读不准就去覆盖用户的选择**）、写也不动；**读写都指定 `--file`（`ctx.home` 下那份），不用 `--global`**（`--global` 靠进程环境变量 `HOME`，测试或 `--home` 传了别的目录时会摸到真机器的 git 全局配置，连 spawn 的子进程也把 `HOME/USERPROFILE` 显式改成 `ctx.home`）。——`git-excludes.test.ts`（17 条）。
15. **各家配置文件里本脚本管的开关**（`tool-config.ts`，目前是 `~/.grok/config.toml` 的目录信任和反问选择题两项，#500）：只动列出来的几项、别的内容（注释、顺序、别的表、CRLF）一个字不动、改之前留备份；**不引 TOML 库整份解析再写回**（会把注释、顺序、格式全丢掉），逐行认——认得准的形状（普通表头、表下一行一个 key）才改；多行字符串、表重复、同一项写了两遍、用点号或内联表写在别处**一律当读不懂**：查报没查成、写不动并报没做成、不猜着改；没装 grok：跳过不建文件；官方安装在 `~/.grok/bin` 不在 `PATH` 也算装了。（Playwright MCP 的输出目录设成 `_tmp/playwright`，#380，开着。）——`tool-config.test.ts`。
16. **写锁**：同一个家目录同一时刻只许一个 `--apply` / `--retire-old` 在写（几个会话同时开，开会话钩子会同时跑同步，两边一起删一起写同一个技能目录会留下写到一半的目录）；锁是 `~/.fleet-dao/agents-sync.lock`（记进程号和时间）；拿锁的进程已不在、或锁放了超过 `STALE_MS`：当成上次崩了留下的、拿过来；`--apply` 时锁被占着：没查成（退出码 2）、说清谁占着、一个字不写。——`lock.test.ts`。

**E. 报告、退出码、撤旧仓、写后回读**

17. **结论**：每项落一行，行首符号和装机脚本（`deploy/lib/common.sh`）一样、`france.sh` 按符号把它接进自己的账——`✓` 一致、`↻` 这次改了、`✗` 漂移/缺失/没做成、`…` 没查成、`·` 没装（跳过）或没东西可做；**退出码：有 ✗ 为 1；没有 ✗ 但有 … 为 2；其余 0**（「没装」不影响退出码但逐项列出、不算进「一致」）；既有漂移又有没查成：退出码 1（红压过没查成，和装机脚本一样）；用法错误（不挑模式、挑两个、认不出的参数、`--retire-old` 不带 `--old-repo`、`--old-repo` 写成相对路径、Windows 上用 `--user`、不是 root 用 `--user`、没有这个用户）退出 64。——`report.ts`；`cli.test.ts`、`bin.test.ts`。
18. **原件读不了就是没查成、一个字不写**：仓里的 `AGENTS.md` 没有通用段（标记不成对、没有标记、标记之间是空的）、仓里没有 `agents/skills/`（检出不全）、家目录不在、换身份失败：没查成、退出码 2；已装过的技能一个不撤。**`--user`**：root 先换成那个用户再写那个用户的家（家目录取自 passwd）；检出落后主线也照样退出 0、不记同步位置；本来就是那个用户不用换身份。——`cli.test.ts`。
19. **写完照查一遍**（`verify`）：写的时候报「改了」或「一致」、读回却漂移、缺失、没查成的，补一行报出来、退出码跟着变；写时已报过「没做成」的同一项不重复报（只认同一项）；**写了不等于写对了**。——`verify.test.ts`。
20. **`--retire-old`**：撤掉旧仓留在这台机器上的两样东西，每项先备份再动、逐项报出来：各家技能目录里指向旧仓的链接（junction 或软链，**只删链接本身，旧仓里的文件一个不碰**；不指向旧仓的链接、真目录一律不碰）、`~/.claude/agents` 里的两个旧子代理 `dao-vps-readback.md`、`dao-chain-diagnoser.md`（`dao-scout`、`dao-fixer` 留着）；第二遍没有要撤的、一处不动。**删东西只经 `removeEntry`：链接只删链接本身，绝不顺着链接删到它指的地方**（旧仓的技能是 junction 链过去的，顺着删就把旧仓的文件删了）。——`retire.ts`、`tree.ts`；`retire.test.ts`。

## 三、现状（做了 / 没做 / 做坏了）

- **做了**：通用段、自研技能、第三方技能、钩子、`_tmp/` 全局忽略、grok 开关、同步位置、开会话自动跟上主线、写锁、撤旧仓；六家 AI 的落点表。
- **做坏了**：**钩子里「调工具前」那条（`pretool.mjs`）拦 AI 读密钥文件**——goals 第六节已拍删（#465 关）；`agents/hooks/` 里还有「认领」相关的推前钩子（`agents` 包，见 `agents.md`）。
- **没做**：各家原生钩子接上（Codex、Kimi Code、Antigravity、Gemini CLI，#232）；`agents-sync` 在 Windows 上的 Bash 环境下 git 的问题（本机 SessionStart 提醒里出现过）。

## 四、对照 `docs/goals.md`：留 / 改 / 删

| 部分 | 处置 | 理由 |
|---|---|---|
| 通用段、技能（自研 + 第三方）、清单、写锁、备份、同步位置、开会话钩子、`_tmp/` 全局忽略、`--retire-old` | **留** | 第四节 G：通用规矩、技能、钩子同步到每台机器的每家 AI（#30 已做）；第三方技能是创始人 2026-09-30 拍 D1 |
| 钩子登记里的 `PreToolUse`（拦读密钥文件）那一条 | **删** | 第六节：拦 AI 读密钥文件的钩子；`Stop`、`SessionStart` 保留 |
| #232（各家原生钩子） | **留** | 第四节 G |
| `tool-config.ts`（grok 开关） | **留** | #500 |

## 五、关联的单

- 开着：#232（各家原生钩子）、#380（Playwright MCP 输出目录）、#317（关，故意失败测试补齐）。
- 关了但规则在这里：#30（规矩与技能同步到各机各家 AI，旧仓工具箱退役）、#317、#484 #329（PR）。
- 完整对账见 `00-单子对账表.md`。

## 六、怎么算做完（重做之后）

1. 任何一家 AI 的全局说明、技能、钩子、配置开关都由 `agents-sync` 一处管；新增一家只改 `targets.ts` 和 `detect.ts`。
2. 「拦读密钥文件」的钩子随 goals 第六节删除（代码、登记、测试、e2e、`README`）；`SessionStart` 和 `Stop` 保留。
3. 每一处「读不到、读不懂、检出不全」都是没查成（退出码 2）并有故意失败用例；第三方技能核不过整体不发。
