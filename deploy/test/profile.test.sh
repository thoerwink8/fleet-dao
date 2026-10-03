#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 本机档（#451，deploy/lib/profile.sh）：FLEET_PROFILE 认不认得出、不带这个变量时默认是不是 france（加本机档之前
# 一个字节都不变的前提）、认不出的档名报不报清楚、is_local_profile 只看 PROFILE 这个全局变量、skip_local 是不是
# 不算红也不算绿（只进 PENDING）；这台记的档位（#323，profile_marker_check）对不上、不是普通文件都不过，france.sh 前提里核、
# 装的时候记、读回报。不要 root，只碰临时目录。
# 用法：bash deploy/test/profile.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
unset FLEET_PROFILE
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/profile.sh
source "$HERE/../lib/profile.sh"
fail=0
skipped=0
pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}

out=$(resolve_profile)
if [[ "$out" == france ]]; then pass "不带 FLEET_PROFILE：默认 france"; else flunk "不带 FLEET_PROFILE 读到「$out」，应为 france"; fi

out=$(FLEET_PROFILE=local resolve_profile)
if [[ "$out" == local ]]; then pass "FLEET_PROFILE=local：读到 local"; else flunk "FLEET_PROFILE=local 读到「$out」"; fi

out=$(FLEET_PROFILE=france resolve_profile)
if [[ "$out" == france ]]; then pass "FLEET_PROFILE=france：读到 france（显式给和不给一样）"; else flunk "FLEET_PROFILE=france 读到「$out」"; fi

err=$(FLEET_PROFILE=bogus resolve_profile 2>&1 1>/dev/null)
rc=$?
if ((rc != 0)) && [[ "$err" == *"认不出的 FLEET_PROFILE"*bogus* ]]; then
  pass "认不出的档名：非 0 退出、报清楚是哪个值（退出码 $rc）"
else
  flunk "认不出的档名应该非 0 退出、报清楚：退出码 $rc，stderr「$err」"
fi

# is_local_profile 只看 PROFILE 这个全局变量（france.sh 里 main 之前、resolve_profile 的结果存的那个），不是
# 再去读一次 FLEET_PROFILE：这样 skip_local 判过一次之后，函数体里能反复用它，不用每次都重新解析
PROFILE=france
if is_local_profile; then flunk "PROFILE=france 不该判成本机档"; else pass "PROFILE=france：is_local_profile 是假的"; fi
PROFILE=local
if is_local_profile; then pass "PROFILE=local：is_local_profile 是真的"; else flunk "PROFILE=local 应该判成本机档"; fi
unset PROFILE
if is_local_profile; then flunk "PROFILE 没设时不该判成本机档（默认当 france，和法国的行为对齐）"; else pass "PROFILE 没设：当 france，不是本机档"; fi

# profile_desired_file：readback_config 拿它决定传不传 --desired（#451）。法国（不设、或显式 france）要拿空
# 字符串——空串意味着 config.mjs 不收 --desired，自己按「在用的那一版」找，法国的判法一个字节都不变；本机档要
# 拿 deploy/local/desired-config.json（不然本机档登记过的差别，比如 FLEET_MACHINE_NAME，会被拿法国那份比
# 出来，当成「手改了、改回去」误判成红）
unset PROFILE
out=$(profile_desired_file /srv/fleet-dao/deploy)
if [[ -z "$out" ]]; then
  pass "profile_desired_file：PROFILE 没设（当 france）不给 --desired 的路径"
else
  flunk "profile_desired_file 在 france 应该是空字符串，读到「$out」"
fi
PROFILE=france
out=$(profile_desired_file /srv/fleet-dao/deploy)
if [[ -z "$out" ]]; then
  pass "profile_desired_file：PROFILE=france 不给 --desired 的路径"
else
  flunk "profile_desired_file 在 france 应该是空字符串，读到「$out」"
fi
PROFILE=local
out=$(profile_desired_file /srv/fleet-dao/deploy)
if [[ "$out" == /srv/fleet-dao/deploy/local/desired-config.json ]]; then
  pass "profile_desired_file：PROFILE=local 给 deploy/local/desired-config.json"
else
  flunk "profile_desired_file 在本机档应为 /srv/fleet-dao/deploy/local/desired-config.json，读到「$out」"
fi
unset PROFILE

# skip_local：不算红也不算绿，只记进 PENDING（common.sh 的退出码：有红 1，没红但有待配 2，全绿 0），文字带
# 「本机档跳过：」前缀，方便和真正「待配」的项在输出里分清楚
out=$(skip_local "没有香港") # 只看打印：$() 起子壳，看不到它对 PENDING 数组的改动
if [[ "$out" == "  … 本机档跳过：没有香港" ]]; then
  pass "skip_local：输出格式和 pending 一样（… 开头）"
else
  flunk "skip_local 输出「$out」，应为「  … 本机档跳过：没有香港」"
fi
CHANGES=()
REDS=()
PENDING=()
skip_local "没有香港" >/dev/null # 不起子壳直接调，才看得到它对这几个数组的改动
if ((${#PENDING[@]} == 1)) && [[ "${PENDING[0]}" == "本机档跳过：没有香港" ]]; then
  pass "skip_local：记进 PENDING，不进 REDS 或 CHANGES"
else
  flunk "skip_local 没正确记进 PENDING：${PENDING[*]-（空）}"
fi
if ((${#REDS[@]} == 0 && ${#CHANGES[@]} == 0)); then
  pass "skip_local：不算红也不算绿"
else
  flunk "skip_local 不该动 REDS 或 CHANGES（REDS=${#REDS[@]} CHANGES=${#CHANGES[@]}）"
fi

# 这台记的档位（#323）：发布、自动发布照它挑哪一份期望写配置、对账，所以 france.sh 跑之前先核——没记、记的就是这一档才往下装；
# 记的是别的档、不是普通文件，都不过（不替人改它）
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
marker_case() { # 说明 期望（过 / 不过） 这次的档位 [PROFILE_WHY 里要有的字]
  local rc=0
  profile_marker_check "$T/profile" "$3" || rc=$?
  if [[ "$2" == 过 && $rc == 0 ]] || [[ "$2" == 不过 && $rc != 0 && "$PROFILE_WHY" == *"${4:-}"* ]]; then
    pass "$1：$2"
  else
    flunk "$1：该$2，返回 $rc，原因「$PROFILE_WHY」"
  fi
}
marker_case "还没记" 过 france
printf 'france\n' >"$T/profile"
marker_case "记的就是法国档" 过 france
marker_case "记的是法国档、这次跑的是本机档（入口用错了）" 不过 local "记的是「france」档"
printf 'local\n' >"$T/profile"
marker_case "记的是本机档、这次跑的是法国档" 不过 france "这次跑的是「france」档"
marker_case "记的就是本机档" 过 local
rm -f -- "$T/profile"
mkdir "$T/profile"
marker_case "档位文件是个目录" 不过 france "不是普通文件"
rmdir -- "$T/profile"
if ln -s "$T/elsewhere" "$T/profile" 2>/dev/null && [[ -L "$T/profile" ]]; then
  marker_case "档位文件是符号链接（断链也算）" 不过 france "不是普通文件"
else
  echo "  … 没跑成：这台建不了符号链接，「是符号链接」没测"
  skipped=1
fi
rm -f -- "$T/profile"
# france.sh 里：前提先核（对不上就停），装的时候记上，读回报出来
france=$(<"$HERE/../france.sh")
preflight_body=$(sed -n '/^preflight() {/,/^}/p' <<<"$france")
identity_body=$(sed -n '/^setup_identity() {/,/^}/p' <<<"$france")
# shellcheck disable=SC2016 # 找的就是字面上的变量名
if [[ "$preflight_body" == *'profile_marker_check "$PROFILE_FILE" "$PROFILE"'* &&
  "$identity_body" == *'put_file "$PROFILE_FILE" root:fleet 640 "$PROFILE"'* && "$france" == *$'\n  readback_profile_marker\n'* ]]; then
  pass "france.sh：前提核档位、装的时候记上、读回报出来"
else
  flunk "france.sh 该在前提里核档位（profile_marker_check）、setup_identity 里记上、读回里报 readback_profile_marker"
fi

if ((fail)); then
  echo "本机档（deploy/lib/profile.sh）：不通过"
  exit 1
fi
if ((skipped)); then
  echo "本机档（deploy/lib/profile.sh）：其余通过，有没跑成的（见上）"
  exit 2
fi
echo "本机档（deploy/lib/profile.sh）：通过"
