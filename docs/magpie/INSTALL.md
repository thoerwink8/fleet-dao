# 从零装到和现有两台一致

现有两台：本机 Windows，法国 Linux。新机器跟法国同一程序版本。2026-11-16 法国是 `0.1.4263`（`/opt/magpie/magpie --version`）。安装包从 magpie 的正式发布取。下面每条 magpie 命令都套超时，原因见 [OPERATIONS.md](OPERATIONS.md)。

令牌和口令只写从哪里取。不要把值写进仓库、单子或这份文档。

## 两边都要做的

1. 数据目录用完，配置放在下面说的配置目录。不要把法国的内网 IP 写进脚本；地址用 `<法国内网地址>`，端口网页 3430、网关 3425。
2. 接同步。在那台机器自己的配置目录里跑（法国要套 `sudo -u magpie env HOME=… XDG_CONFIG_HOME=…`，变量从 `/etc/magpie.env` 取）：

   ```sh
   timeout 30 magpie github on github://thoerwink8/fleet-setup/magpie keys=no
   timeout 20 magpie github set sign-ins=no
   timeout 20 magpie github auto 3
   ```

   `keys=no` 不带密钥。`sign-ins=no` 不带登录。`auto 3` 每 3 分钟。同步是口令加密的，GitHub 上只有封好的文件。

   0.1.4263 的 `magpie github set` 帮助里能关的是 providers、settings、profiles、keys、agents、library、memory、usage、sign-ins，没有 delete 开关。不带删除的做法：不要删仓库里的加密文件，不要 `magpie github off` 以外再去清历史（`off` 本身会留下加密文件和提交历史），不要 `magpie uninstall`。帮助里以后若出现 delete，保持关闭。

3. 令牌：`magpie github on` 会问。从密码管理器取已经发给私有仓 `thoerwink8/fleet-setup` 的那把，权限是 Contents 读写。没有就在 GitHub 上现发一把，只给这个仓，发完放进密码管理器。不进 git。
4. 口令：`magpie github on` 会问。从密码管理器取，每台同一句。不进 git。它和 vault 的 age 口令是不是同一把：未查到，不要混用。
5. 手登。登录不同步。法国网关上的 Grok、Cursor、Devin 只在法国登。只来调用的新机器不登这些订阅，只配下面的调用 key。Antigravity 只在本机 Windows 经 agy 登。Claude 不进 magpie。
6. 手填 key。只填名字对得上的那把，值从来源取，不写进文档。

   | 名字 | 来源 |
   |---|---|
   | 调用 key（每台一把，具体名字未查到） | 法国 magpie 网页里发给这台的调用方 key，落在这台的 `caller-keys.json`。不进同步 |
   | 供应商 API key（供应商 id 未查到） | 各家控制台，或密码管理器里按供应商 id 记下的那把。`keys=no`，不进同步 |

7. 核对：`install/magpie-verify.sh`（Windows 用 `install/magpie-verify.ps1`）。不一致会打印差异并退出非 0。对照的是 `templates/magpie-expected.json`。

`install/magpie-bootstrap` 只准备配置目录和一份不含密钥的契约文件 `bootstrap-state.json`，好让核对能对上同步约定。它不调用 `magpie github on`，也不写 key。`--dry-run` 只打印会做什么。

## Windows

1. 安装程序放到 `D:\magpie\magpie.exe`。配置目录用 `~/.config/magpie`（也就是用户目录下的 `.config\magpie`）。
2. 先起一次程序，让配置目录落下来。不要把这次的网页钥匙抄下来。
3. 在这个配置目录对应的用户下做上面的「接同步、手登、手填 key」。本机这层只留本机独有的（reclaude 的 Claude 用量、Antigravity）和远端不通时的直连兜底 key。兜底 key 的供应商 id 未查到，从密码管理器按本机直连那一组取。
4. 跑 `install/magpie-bootstrap.ps1`，再跑 `install/magpie-verify.ps1`。

## Linux

1. 系统用户 `magpie`，家目录 `/var/lib/magpie`，登录 shell 用 `nologin`。程序放到 `/opt/magpie/magpie`，版本跟法国现在的 `0.1.4263`。
2. `/etc/magpie.env` 放运行需要的变量，至少要能取出 `HOME` 和 `XDG_CONFIG_HOME`。文件权限收成 root 和 magpie 可读，不要进 git。数据目录就是这里的 `HOME`。配置目录是 `XDG_CONFIG_HOME/magpie`；变量没设时用 `$HOME/.config/magpie`。
3. 单元只听内网：网页 `--addr <法国内网地址>:3430`，网关 `MAGPIE_ADDR=<法国内网地址>:3425`。不要对公网开 3430 或 3425。`deploy/france.sh` 不负责这个单元。
4. 日常命令：

   ```sh
   sudo -u magpie env HOME=… XDG_CONFIG_HOME=… /opt/magpie/magpie
   ```

   `HOME` 和 `XDG_CONFIG_HOME` 从 `/etc/magpie.env` 取。
5. 用这个用户做「接同步、手登、手填 key」。同步契约也可以先在目标配置目录上演练：

   ```sh
   node install/magpie-bootstrap.mjs --dry-run --config <配置目录>
   node install/magpie-bootstrap.mjs --config <配置目录>
   ```

   `--dry-run` 不建目录、不写文件。正式跑第二次应该报告没有变化。
6. 跑 `install/magpie-verify.sh`。法国这台在契约文件还没写上之前，同步一项会显示读不到，退出非 0。那是还没接上同步约定，不是程序坏了。
