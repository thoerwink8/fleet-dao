#!/usr/bin/env bash
# deploy/ 的全部检查：语法、shellcheck、自检的违规样本、发布脚本的来回（换版、自动退回、只留几版、飞书网关发不发）、
# 香港网关入口（fleet-gateway-deploy）、飞书网关打包、静态文件发到香港哪几处（演示版、根地址、可见范围不删）、
# 演示版的可见范围推到香港、公网上看得到的几样（占位页、健康页不带真名，release.json 只给隧道，整站不让搜索引擎收录）、
# 健康页的判定、docs/ops.md 端口表和脚本对得上、docs/ops.md 里放文件的命令收到空的或半截的不换（place-file）。
# 用法：sudo bash deploy/test/run.sh（违规样本那项要 root）。退出码：0 通过，1 有不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
OPS=$DEPLOY/../docs/ops.md
fail=0
skipped=0

mapfile -t scripts < <(find "$DEPLOY" -name '*.sh' | sort)
for f in "${scripts[@]}"; do
  if ! bash -n "$f"; then
    echo "不通过：语法错 $f"
    fail=1
  fi
done
echo "语法：查了 ${#scripts[@]} 个脚本"

if command -v shellcheck >/dev/null; then
  if shellcheck -x -S style "${scripts[@]}"; then echo "shellcheck：通过"; else fail=1; fi
else
  echo "没跑成：这台没有 shellcheck"
  skipped=1
fi

bash "$HERE/login-user.test.sh"
case $? in
0) ;;
2) skipped=1 ;;
*) fail=1 ;;
esac

bash "$HERE/root-exec-check.test.sh"
case $? in
0) ;;
2) skipped=1 ;;
*) fail=1 ;;
esac

for t in release-flow gateway-deploy gateway-bundle web-publish demo-scopes place-file public-site; do
  bash "$HERE/$t.test.sh"
  case $? in
  0) ;;
  2) skipped=1 ;;
  *) fail=1 ;;
  esac
done

bash "$DEPLOY/backup/test/backup.test.sh"
case $? in
0) ;;
2) skipped=1 ;;
*) fail=1 ;;
esac

bash "$HERE/agent-scope-adopt.test.sh"
case $? in
0) ;;
2) skipped=1 ;;
*) fail=1 ;;
esac

bash "$HERE/app-config.test.sh"
case $? in
0) ;;
2) skipped=1 ;;
*) fail=1 ;;
esac

if command -v node >/dev/null; then
  if node --test "$HERE/health-page.test.mjs"; then echo "健康页的判定：通过"; else fail=1; fi
else
  echo "没跑成：这台没有 node，健康页的判定没测"
  skipped=1
fi

for t in agents-sync agents-sync-account cli-tools; do
  bash "$HERE/$t.test.sh"
  case $? in
  0) ;;
  2) skipped=1 ;;
  *) fail=1 ;;
  esac
done

# 端口表：脚本里定的每个端口号都要出现在 docs/ops.md 里（改了端口忘了改文档，这里会红）
ports=$(grep -hoE '^[A-Z_]*PORT=[0-9]+' "$DEPLOY/france.sh" "$DEPLOY/hk.sh" | cut -d= -f2 | sort -u)
if [[ -z "$ports" ]]; then
  echo "没跑成：脚本里一个端口都没读到"
  skipped=1
else
  missing=""
  for p in $ports; do
    if ! grep -qw -- "$p" "$OPS"; then missing+=" $p"; fi
  done
  if [[ -n "$missing" ]]; then
    echo "不通过：docs/ops.md 的端口表里没有$missing"
    fail=1
  else
    echo "端口表：$(wc -w <<<"$ports") 个端口都在 docs/ops.md 里"
  fi
fi

if ((fail)); then exit 1; fi
if ((skipped)); then exit 2; fi
echo "deploy/ 检查全部通过"
