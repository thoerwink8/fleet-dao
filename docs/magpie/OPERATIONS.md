# magpie 日常

命令都在对应的配置目录上跑。法国：

```sh
sudo -u magpie env HOME=… XDG_CONFIG_HOME=… timeout 20 /opt/magpie/magpie <子命令>
```

`HOME` 和 `XDG_CONFIG_HOME` 从 `/etc/magpie.env` 取。下面为了短，写成 `timeout 20 magpie …`，跑的时候仍要套这个用户和环境。输出里的钥匙、令牌、邮箱、账号 ID 不要贴进文档或单子。

## 用量

近 30 天：

```sh
timeout 30 magpie usage 30d
```

当天用 `usage today`。`--csv` 是逐条请求，容易带上账号，只在这台看，不往外贴。汇总进 [INVENTORY.md](INVENTORY.md) 时只留合计，并去掉邮箱和账号 ID。2026-11-16 的合计未查到。

## 改权重和 fast 比例

权重和 fast 分开写。权重键只写模型 id，数字是 1 到 1000。fast 用 `fast=`，表示这些成员走厂商的 fast 模式。

```sh
timeout 20 magpie group set <组> routing=weight weight=<模型甲>=2,<模型乙>=1
timeout 20 magpie group set <组> fast=<要走-fast-的模型>
```

grok 池的 2:1 和 fast 嵌套见 [DECISIONS.md](DECISIONS.md)。具体成员未查到，不要按猜的 id 去改在跑的组。

改完按 [DECISIONS.md](DECISIONS.md) 对 smart 做 md5：先 `timeout 20 magpie group smart`，滤掉插件行，再去掉任何钥匙和账号，只对路由、成员和权重那几行算。两边的摘要要一致。对哪一段字节算的出处未查到；不要把命令输出贴出来。

## 暂停

暂停同步：

```sh
timeout 20 magpie github auto off
```

恢复每 3 分钟：`timeout 20 magpie github auto 3`。

暂停一组的分流：`timeout 20 magpie group set <组> routing=manual`，再用 `timeout 20 magpie group pick <组> <留下的模型>`。不要在同一次 `weight=` 里夹 `:fast`。

停法国的 `magpie.service` 会让走这台网关的机器都没有模型。决定 0128 的本机直连只兜本机那层。停之前先确认。这个单元不归 `deploy/france.sh`。

## 同步冲突

先看，不改：

```sh
timeout 20 magpie github preview
```

两边改了同一块时，不要 `magpie github restore`（那是用这台盖掉仓库）。`timeout 20 magpie github undo-sync` 只把这台刚才拉下来的退回去。

新机器第一次接上，用 `timeout 20 magpie github follow on`：只跟仓库，不把这台的空配置推上去。

删除不传播：不要删仓库里的加密文件。`github off` 会留下加密文件和提交历史。0.1.4263 没有 `delete=no` 这个开关，见 [INSTALL.md](INSTALL.md)。

WebDAV 的公开说明写冲突时保留较新的一份。GitHub 这条在 0.1.4263 的帮助里没有单独一句，未查到是不是同一套。

## 两边不一致

1. 各跑 `install/magpie-verify.sh`（Windows 用 `.ps1`）。差异打在 stdout，退出码非 0。
2. 法国是唯一网关。调用方跟仓库，不要两台同时把本地推上去。
3. 对不齐时以法国那份为准：调用方 `follow on`，再核对。本机独有的 Claude 和 Antigravity 本来就不在同步里。
4. 同步约定还没写成配置目录里的 `bootstrap-state.json` 时，核对会报同步读不到。先按 [INSTALL.md](INSTALL.md) 接同步，或在目标目录跑 `install/magpie-bootstrap`（先 `--dry-run`）。

## 已踩的坑

**插件行要过滤。** `magpie providers` 和 `magpie groups` 的输出里会有社区插件订阅。拿去对配置或算 md5 之前先丢掉带 plugin / 插件的行，不然会把插件当成渠道 key。0.1.4263 在空配置下这两条没有插件行；在跑的实例上插件行的原文未查到。过滤时不要把剩下的行打进文档。

**权重键里的 `:fast` 会整条失败。** `weight=` 的键只写模型 id。键里夹了 `:fast` 时，整条 `group set` 失败，这一组权重都没写上。fast 用单独的 `fast=`。2026-11-16 在临时空配置里，单独一条 `weight=<模型>:fast=<数字>` 被 0.1.4263 接受并写成了权重；仍然不要这么写，避免和会整条失败的写法混在一起。

**命令要套超时。** `magpie` 会去拉模型列表或连同步，裸跑会挂住。Linux 用 `timeout 20`（用量用 `timeout 30`）。Windows 在 Git Bash 里同样套 `timeout`。超时到了就是没跑完，不要当成已经改好。
