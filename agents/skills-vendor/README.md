# 第三方 skill（网上公开的，原样拷进来）

## 这里放什么

网上公开的基础 skill（先写测试、系统排错、完成前验证、git 工作树、网页测试、前端设计、写 MCP 服务这一类），**从公开仓原样拷进来、一个字不改**。自研的方法类 skill 不放这里，放 `agents/skills/`（创始人 2026-09-30 拍：自研和公开的分开，公开的拷贝式，不用软链接——Windows 上建软链要管理员权限，上游一改就直接进所有 AI，出问题回不了头）。

同步脚本 `packages/agents-sync` 把这里核过锁文件的 skill，和 `agents/skills/` 里自研的一起拷进各家 AI 的 skill 目录，一起撤；两边有同名的，直接报错、一个都不发。

## 现在收了哪些（8 个）

| skill | 来自 | 许可证 | 一句话 |
|---|---|---|---|
| `test-driven-development` | obra/superpowers | MIT | 先写会失败的测试，看它失败，再写最少的代码 |
| `systematic-debugging` | obra/superpowers | MIT | 出了错先找根子，不许先打补丁 |
| `verification-before-completion` | obra/superpowers | MIT | 没跑过验证命令，不许说做完了 |
| `receiving-code-review` | obra/superpowers | MIT | 收到审查意见先核对再动手，不假装同意 |
| `using-git-worktrees` | obra/superpowers | MIT | 干活先确认在隔离的工作树里 |
| `frontend-design` | anthropics/skills | Apache-2.0 | 做界面要有自己的取舍，别出模板脸 |
| `webapp-testing` | anthropics/skills | Apache-2.0 | 用 Playwright 测本地网页（要本机有 Python 版 Playwright） |
| `mcp-builder` | anthropics/skills | Apache-2.0 | 写 MCP 服务的做法和评测（评测脚本会调 Anthropic API，要花钱） |

来源仓、40 位提交号、每个文件的哈希、谁在哪天审过、和本仓规矩冲突的地方（`notes`），都在 `vendor.lock.json`。

## 审过没收的

| skill | 为什么 |
|---|---|
| `subagent-driven-development`、`dispatching-parallel-agents`（superpowers） | 整套靠派子代理，和创始人 2026-09-28「不再开 Claude 子代理」冲突（那条临时调整 2026-10-01 已撤回，这两个要不要收另走下面「加一个新的」） |
| `requesting-code-review`（superpowers） | 流程就是「派一个子代理去审」，同上（那条已撤回）；本仓审 PR 走 `discuss` 技能的第二意见（别家模型）。创始人 2026-09-30 00:08 列的第一批里有它，逐个文件通读时才发现，所以没收 |
| `skill-creator`（anthropics/skills） | 默认流程靠派子代理、用 `claude -p` 循环几百次调 Claude（烧额度），教的描述写法和 `agents/test/skills.test.ts` 的 120 字上限冲突；同上是通读时才发现。本仓写 skill 照 `agents/skills/README.md` |
| `using-superpowers`、`brainstorming`、`writing-plans`（superpowers） | 会和本仓的规矩抢谁说了算，或和 `best-practice-first`、`discuss` 重叠 |

没看过、不在第一批的：superpowers 的 `diagnosing-superpowers`、`executing-plans`、`finishing-a-development-branch`、`writing-skills`，和 anthropics/skills 里其余的 skill（其中 docx、pdf、pptx、xlsx 那四个是「源码可见、不是开源」的许可，不能放进公开仓）。要收哪个，走下面「加一个新的」。

## 怎么保证它不被悄悄改（防供应链投毒）

第三方 skill 是喂给每台机器上每个 AI 的指令，一个字就能改 AI 的行为。所以：

1. **锁文件**（`vendor.lock.json`）：来源仓、40 位提交号（不写分支、标签）、许可证、每个文件的 sha256、审查人、审查日期。
2. **分发前核锁，核不过整体不发**：目录里多了、少了、改了任何一个文件，有链接，`SKILL.md` 头上的 `name` 和目录名不一样，许可证不在白名单（只认 MIT、Apache-2.0，白名单写在 `packages/agents-sync/src/vendor.ts`），都是「没查成」。核不过时自研的规矩也一起不同步——宁可停下，不带着没审过的东西往每台机器上发。测试在 `packages/agents-sync/test/vendor.test.ts`（每种「不对」各造一次）和 `packages/agents-sync/test/vendor-repo.test.ts`（看仓里这份真目录）。
3. **改这里的任何文件都要先审后合**：`packages/conventions/high-risk-paths.json` 登记了这个目录（第二意见通过才能合）；改到 `.md` 还算改标准（`packages/conventions/standard-paths.json` 里的 `agents/**/*.md`），要创始人同意。
4. **不联网、不自动更新**。升级只能手动，看得见差异。
5. 许可证原文随 skill 一起分发（MIT 的版权声明、Apache 的 `LICENSE.txt`）。superpowers 那几个上游只在仓根放了一份 `LICENSE`，我们在每个 skill 目录里各拷一份（锁文件的 `added` 里记着），这是这里唯一加的文件。

第三方的 `.ts`、`.py`、`.sh` 不进本仓的格式检查和类型检查（`biome.json` 排除了这个目录，`agents/tsconfig.json` 只管 `test`）。

## 怎么升级一个

没有自动更新。手动来，每一步都留得下证据：

1. 把上游新版拉到临时目录（仓根的 `_tmp/`），记下新的 40 位提交号。
2. `node packages/agents-sync/bin/agents-vendor diff <skill 名> --from <上游里那个 skill 的目录>`：列出多了、少了、改了哪几个文件；逐行看用 `git diff --no-index`。
3. **逐个文件读**：脚本逐行读；扫隐藏字符和双向控制字符（零宽字符、`U+202E` 这类）；看有没有新的联网、写盘、开子代理、要密钥的地方；有新文件先想清楚要不要收（不收的写进 `leftOut`）。
4. 拷进来，手改 `vendor.lock.json` 里的 `commit`、`commitDate`、`leftOut`、`notes`，然后 `node packages/agents-sync/bin/agents-vendor rehash <skill 名> --reviewed-by <谁> --date <日期>` 重算文件哈希，`agents-vendor verify` 核一遍。
5. 开 PR，正文写清读了什么、有没有新风险，走先审后合；改到 `.md` 的等创始人同意。

## 怎么加一个新的

同样先读完（上面第 3 步），再：在 `vendor.lock.json` 的 `sources` 里登记来源（没有就加）、在 `skills` 里手写这个 skill 的 `source`、`path`、`license`、`notes`，`files` 先写 `{}`；把上游目录原样拷进 `agents/skills-vendor/<名>/`（名字要和 `SKILL.md` 里的 `name` 一样）；`rehash`、`verify`；README 的表里加一行。许可证不是 MIT 或 Apache-2.0 的不收。

## 用之前看一眼：和本仓规矩冲突的地方

这些 skill 是别人写给别的环境的，遇到和本仓 `AGENTS.md`、创始人当轮指示冲突，以本仓和创始人为准。已知的几处（全文在 `vendor.lock.json` 的 `notes`）：

- **本机不跑全量测试**：skill 里的 `npm test`、「先跑整个项目的测试」，在本仓换成 `pnpm exec vitest run <文件>` 或 `pnpm test:changed`，全量交给 CI；本仓用 pnpm，不用 npm。
- **密钥、令牌的值不进对话和日志**：`systematic-debugging` 的多层诊断示例（`echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"`、`env | grep …`）会把值打出来，本仓只报「有没有设」。
- **规矩靠 `agents/test/rules/` 里对说明文字的断言钉住**：`test-driven-development/writing-good-tests.md` 说「不要断言文件里有某行文字」，不适用那一处。
- **花钱要创始人点头**：`mcp-builder/scripts/evaluation.py` 调 Anthropic API、按量计费。
- **第三方脚本可以也应该读**：`webapp-testing` 说「别读脚本源码、当黑盒用」，本仓不这样。
