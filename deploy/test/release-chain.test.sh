#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # PENDING、FLEET_SERVICES、PROFILE 这些是给 source 进来的 release.sh 里的函数读写的
# deploy/release.sh 的 health_gate 最后那一步「经香港取 /healthz」（check_chain，#803）：本机档没有香港，不去取、记
# 「本机档跳过：没有香港」，不再每次发布都多一项 HTTP 000 的待配；法国（以及不认得的档位，默认就是 france）照旧去取。
# 故意造出来的失败：本机档却还在去香港取（check_chain 被调了）；法国档却跳过了（check_chain 没被调）。
# 其余每一步（起稳、后端、引擎、网关）换成空桩：这里只看最后一步分不分档。用法：bash deploy/test/release-chain.test.sh。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步

FLEET_SERVICES=""
FLEET_HK_PARTS=""
CHAIN_CALLS=0
check_chain() { CHAIN_CALLS=$((CHAIN_CALLS + 1)); }

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
run_gate() { # 档位：本机档/法国档跑一遍健康检查最后一步，记 check_chain 调了几次、待配里有没有那句
  PROFILE=$1
  CHAIN_CALLS=0
  PENDING=()
  health_gate 0000000000000000000000000000000000000000 >/dev/null 2>&1
  GATE_RC=$?
}
skipped_line() { printf '%s\n' "${PENDING[@]:-}" | grep -c '本机档跳过：没有香港：不经香港取 /healthz'; }

echo "== 本机档：不去香港取，记「本机档跳过」"
run_gate local
check "本机档：健康检查本身没红（返回 0）" "$GATE_RC" 0
check "本机档：check_chain 一次都不该调（没有香港）" "$CHAIN_CALLS" 0
check "本机档：待配里有一条「本机档跳过：没有香港：不经香港取 /healthz」" "$(skipped_line)" 1

echo "== 法国档：照旧去取、不记跳过"
run_gate france
check "法国档：健康检查没红" "$GATE_RC" 0
check "法国档：check_chain 调一次（去香港取）" "$CHAIN_CALLS" 1
check "法国档：待配里没有「本机档跳过」那句" "$(skipped_line)" 0

echo "== 【故意造出的失败】档位没定（空）：按法国算，不能误跳过香港那一步"
run_gate ""
check "没定档位：check_chain 调一次" "$CHAIN_CALLS" 1
check "没定档位：不记「本机档跳过」" "$(skipped_line)" 0

if ((fail)); then
  echo "release-chain：不通过"
  exit 1
fi
echo "release-chain：通过"
