#!/usr/bin/env bash
# run.sh --ops（CI 里只改了 docs/ops.md 时跑的那条路，ci-plan.ts 的 deploy=ops）：真跑了读 ops.md 的两块（端口表、place-file），
# 不是空跑冒充通过。把 deploy/ 和 docs/ops.md 拷进临时目录，在拷贝上改 ops.md 再跑 --ops：
# 原样的过、端口表删掉一个端口的红、放文件那一行删掉的红（没跑成）、参数认不出的退出 2；并且 --ops 不跑全套（没有语法那项）。
# 用法：bash deploy/test/ops-only.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
OPS=$DEPLOY/../docs/ops.md
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

REPO=$TMP/repo
mkdir -p "$REPO/docs"
cp -R -- "$DEPLOY" "$REPO/deploy"
OUT=$TMP/out
RC=0
run_ops() { # 拿哪份 ops.md 跑 [run.sh 的参数，默认 --ops]
  cp -- "$1" "$REPO/docs/ops.md"
  bash "$REPO/deploy/test/run.sh" "${2---ops}" >"$OUT" 2>&1
  RC=$?
}
has() { grep -cF -- "$1" "$OUT" | tr -d ' '; }

PORT=$(grep -hoE '^[A-Z_]*PORT=[0-9]+' "$DEPLOY/france.sh" | head -n 1 | cut -d= -f2)
if [[ -z "$PORT" ]] || ! grep -qw -- "$PORT" "$OPS"; then
  echo "  … 没跑成：france.sh 里没读到端口，或 docs/ops.md 里本来就没有它（PORT=${PORT:-空}）"
  echo "ops-only：没跑成"
  exit 2
fi
PLACE_LINE="france/etc/fleet-dao/catalog.json.age | ssh <法国> '"
if [[ "$(grep -cF -- "$PLACE_LINE" "$OPS")" != 1 ]]; then
  echo "  … 没跑成：docs/ops.md 里放目录配置那一行不是恰好一行"
  echo "ops-only：没跑成"
  exit 2
fi

echo "== 原样的 ops.md：过，两块都跑了，没跑全套"
run_ops "$OPS"
check "退出码" "$RC" 0
check "端口表那块跑了" "$(has '端口表：')" 1
check "place-file 跑了且通过" "$(has 'place-file：通过')" 1
check "没跑全套（没有语法那项）" "$(has '语法：查了')" 0
if ((RC != 0)); then cat -- "$OUT"; fi

echo "== 端口表删掉 $PORT：红"
sed -E "s/(^|[^0-9])$PORT([^0-9]|$)/\1____\2/g" "$OPS" >"$TMP/ops-no-port.md"
check "拷贝里真删掉了" "$(grep -cw -- "$PORT" "$TMP/ops-no-port.md" | tr -d ' ')" 0
run_ops "$TMP/ops-no-port.md"
check "退出码" "$RC" 1
check "说了缺哪个端口" "$(grep -c "端口表里没有.* $PORT\b" "$OUT" | tr -d ' ')" 1

echo "== 放目录配置那一行删掉：红（place-file 没跑成）"
grep -vF -- "$PLACE_LINE" "$OPS" >"$TMP/ops-no-place.md"
run_ops "$TMP/ops-no-place.md"
check "退出码" "$RC" 2
check "place-file 报没跑成" "$(has 'place-file：没跑成')" 1

echo "== 参数认不出：退出 2，不当成全套或 --ops"
run_ops "$OPS" --opz
check "退出码" "$RC" 2
check "说了认不出" "$(has '认不出的参数')" 1

if ((fail)); then
  echo "ops-only：不通过"
  exit 1
fi
echo "ops-only：通过"
