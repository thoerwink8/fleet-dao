#!/usr/bin/env bash
# 真实 root FD/隔离事务协议；测试模块只在测试进程改 BASE，不给生产 helper 开测试根。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ((EUID != 0)); then
  echo '没跑成：要 root'
  exit 2
fi
if [[ ! -x /usr/bin/python3 ]]; then
  echo '没跑成：缺少 /usr/bin/python3'
  exit 2
fi
exec /usr/bin/python3 -I -S "$HERE/tree-usage.test.py" -v
