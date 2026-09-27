#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 会话用户的 Cursor API 密钥：放、查、撤（docs/ops.md 第五节「会话用户的 Cursor 密钥」；判据和做法在 lib/cursor-key.sh）。
# 在法国以 root 跑；值一律不打，结论里只有路径、属主、权限、字节数。
#   <密钥> | bash deploy/cursor-key.sh put   从标准输入收一把：以会话用户的身份先核（非空、只有一行、没有空白和控制字符）、
#                                            再落临时名、再换上；收到空的、不像一把密钥的不换，原来那份原样留着
#   bash deploy/cursor-key.sh check          只看在不在、属主、权限、大小，不读值（france.sh 的读回是同一段）
#   bash deploy/cursor-key.sh remove         删掉（先在 Cursor 后台撤掉那一把）
# 退出码：0 成了；1 没成或有红；2 待配（还没放）；64 用法不对。
set -Eeuo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
# shellcheck source=lib/session-user.sh
source "$HERE/lib/session-user.sh"
# shellcheck source=lib/cursor-key.sh
source "$HERE/lib/cursor-key.sh"

usage() {
  echo "用法：<密钥> | bash deploy/cursor-key.sh put；bash deploy/cursor-key.sh check；bash deploy/cursor-key.sh remove" >&2
  exit 64
}

if (($# != 1)); then usage; fi
case $1 in
put | check | remove) ;;
*) usage ;;
esac
if ((EUID != 0)); then
  echo "要以 root 跑（再以会话用户的身份读写他家里的文件）" >&2
  exit 1
fi
# 在终端里直接敲会回显：只收管道、重定向进来的
if [[ "$1" == put && -t 0 ]]; then
  echo "要从标准输入给密钥（例如 cat /dev/clipboard | ssh <法国> 'bash /srv/fleet-dao/deploy/cursor-key.sh put'），不在终端里敲：会显示在屏幕上" >&2
  exit 64
fi
U=$SESSION_USER
F=$(cursor_key_file "$U")
if ! id "$U" >/dev/null 2>&1; then
  red "$U 这个用户还没有：先跑 bash deploy/france.sh 建它"
  finish
fi
case $1 in
put) cursor_key_put "$U" "$F" || true ;;
check) check_cursor_key "$U" "$F" ;;
remove) cursor_key_remove "$U" "$F" || true ;;
esac
finish
