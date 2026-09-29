#!/bin/bash
# restic-password-check.sh：核对「你手上那份仓库口令」真能打开香港的备份仓库（法国上，root 跑，你自己在网页终端里敲）。
# 为什么要做：万一法国整台没了，香港上只有密文，口令只在法国的 /etc/fleet-dao/backup/restic.pass 和你的密码管理器里；
# 你手里那份要是抄错、过期，「换机恢复」那天才发现就晚了。这一条在升级前必须过一次。
# 只读：只做 `restic cat config`（解密仓库的配置头，打印仓库编号），不备份、不删、不改；不写口令到磁盘
# （只放进内存文件系统 /dev/shm 的一个 600 临时文件，跑完立即抹掉）；口令不回显、不进命令行、不进日志。
# 用法：把这个文件放到法国（我经 ssh 放好），你在网页终端里：  bash /root/restic-password-check.sh
# 然后按提示粘贴口令（64 位小写十六进制，不显示）；看到「✓ 这份口令能打开香港的备份仓库」就行。
set -uo pipefail
umask 077
LIB=/usr/local/lib/fleet-dao/backup/lib.sh
if ((EUID != 0)); then echo "没跑成：要 root"; exit 2; fi
# shellcheck disable=SC1090
source "$LIB" 2>/dev/null || { echo "没跑成：读不到 $LIB（备份没装好？先跑 deploy/backup/install.sh france）"; exit 2; }
[[ -x "$BK_RESTIC" ]] || { echo "没跑成：找不到 restic：$BK_RESTIC"; exit 2; }

printf '粘贴 restic 仓库口令（不显示，回车结束）：'
IFS= read -r -s PASS
echo
PASS=${PASS//[$'\r\n\t ']/} # 网页终端粘贴常带回车、行尾空格
if ! [[ "$PASS" =~ ^[0-9a-f]{64}$ ]]; then
  echo "✗ 格式不对：应当是 64 位小写十六进制（现在是 ${#PASS} 个字符）。多半抄错了、或混进了空格/换行。"
  exit 1
fi
TMP=""
CACHE=""
cleanup() { [[ -n "$TMP" ]] && { shred -u "$TMP" 2>/dev/null || rm -f "$TMP"; }; [[ -n "$CACHE" ]] && rm -rf "$CACHE"; }
trap cleanup EXIT
TMP=$(mktemp -p /dev/shm restic-pass.XXXXXX) || { echo "没跑成：建不了临时文件"; exit 2; }
CACHE=$(mktemp -d -p /dev/shm restic-cache.XXXXXX) || { echo "没跑成：建不了临时目录"; exit 2; }
printf '%s' "$PASS" > "$TMP"
unset PASS

OUT=$("$BK_RESTIC" --repo "sftp:$BK_HK_USER@$BK_HK_ADDR:$BK_REPO_PATH" --password-file "$TMP" --cache-dir "$CACHE" --no-lock \
  -o sftp.command="ssh $(bk_ssh_opts) $BK_HK_USER@$BK_HK_ADDR -s sftp" cat config 2>&1)
rc=$?
if ((rc == 0)); then
  id=$(printf '%s' "$OUT" | sed -n 's/.*"id"[: ]*"\([0-9a-f]\{8\}\)[0-9a-f]*".*/\1/p' | head -1)
  echo "✓ 这份口令能打开香港的备份仓库（仓库编号开头 ${id:-读不出}）。"
  exit 0
fi
# 失败：区分「口令不对」和「连不上」——别让人以为口令错了其实是网不通
if printf '%s' "$OUT" | grep -qi 'wrong password\|no key found'; then
  echo "✗ 口令不对：这份打不开仓库。先别升级；换一份再试，或对着法国上的 /etc/fleet-dao/backup/restic.pass 核（别把它贴进对话）。"
  exit 1
fi
echo "没跑成：连不上香港的仓库（不是口令的问题）：$(printf '%s' "$OUT" | tail -3 | tr '\n' ' ' | head -c 300)"
exit 2
