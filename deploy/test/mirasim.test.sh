#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/mirasim.sh（会话用户自己的 Mirasim 服务，读回 check_mirasim）的判据，每条失败路径都故意造出来：
#   0. mirasim_run_dir 和 packages/engine/src/real/index.ts 的 DEFAULT_MIRASIM_HOME 拼出同一个位置（两边一个改了
#      另一个没改，这条先炸）
#   1. 目录不在（会话用户从没碰过 Mirasim，最常见的起始状态）：待配，不判红——这条曾经是错的：ls 找不到目录退出 2，
#      和 runuser 本身跑不起来分不清，一律判红；#345 修过，这条钉住不再退回去
#   2. 目录在、一份令牌都没有：待配，同一条 fix 文案
#   3. 恰好一份：判绿，报端口；令牌内容不读——测试文件里放一段独有的假内容，全部输出里搜不到
#   4. 不止一份：判红，列出文件名，说清「只该有一份」
#   5. 目录真读不了（属主、权限不对，不是没有）：判红，和「目录不在」分开——不能把「读不了」误判成「还没装」，
#      也不能把「还没装」误判成「读不了」
#   6. runuser 本身跑不起来（这个系统用户不存在）：判红，把 runuser 自己的报错带出来（不是空的）
# 不像 grok.test.sh、cursor-key.test.sh：check_mirasim 只读，没有 ensure_/put_/remove_，用不上 CHANGES；
# MIRASIM_RUN_DIR 是特意留给测试改的模板（lib/mirasim.sh 顶上的 shellcheck 注释），指到 $T 下面，不碰真的 /home。
# 要 root：得建临时用户、以他的身份跑。用法：sudo bash deploy/test/mirasim.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/mirasim.sh
source "$HERE/../lib/mirasim.sh"

if ((EUID != 0)); then
  echo "mirasim：没跑成：要 root（得建临时用户、以他的身份跑）"
  exit 2
fi

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的（grep -E）
  if grep -qE -- "$3" <<<"$2"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
last() { # 数组名：最后一条
  local -n arr=$1
  if ((${#arr[@]})); then printf '%s' "${arr[-1]}"; fi
}
fresh() { CHANGES=() REDS=() PENDING=(); }

echo "== 0. mirasim_run_dir 和引擎的 DEFAULT_MIRASIM_HOME（/home/{user}）拼出同一个位置"
check "默认模板套用户名" "$(mirasim_run_dir fleet-agent-carpool)" "/home/fleet-agent-carpool/.mirasim/run"

U=fleet-mirasim-test-$$
T=$(mktemp -d /var/tmp/mirasim-test.XXXXXX)
cleanup() {
  pkill -KILL -u "$U" >/dev/null 2>&1
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$T"
}
trap cleanup EXIT
chmod 755 "$T"
H=$T/home
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "mirasim：没跑成：建不了临时用户 $U"
  exit 2
fi
# 把模板指到 $T 下面：不碰真的 /home，check_mirasim 全靠这个模板算目录，和这个用户真正的家目录无关
# （MIRASIM_RUN_DIR 是 lib/mirasim.sh 特意留给调用方和测试改的，见它顶上的 shellcheck 注释）
RUN_BASE=$T/run-dirs
install -d -o root -g root -m 755 "$RUN_BASE"
MIRASIM_RUN_DIR="$RUN_BASE/{user}/.mirasim/run"
DIR=$(mirasim_run_dir "$U")

echo "== 1. 目录不在（最常见的起始状态）：待配，不判红——曾经错判成红，这条钉住"
fresh
check_mirasim "$U" >/dev/null
check "记一笔待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
has "待配写清没有这个目录、怎么配" "$(last PENDING)" "还没有自己的 Mirasim 服务（没有 $DIR）：创始人.*docs/ops.md 第五节「会话用户的 Mirasim」"

echo "== 1b.【故意造出的失败】照 france.sh 挂上 ERR 陷阱再跑「目录不在」：陷阱不许响，照样记待配、返回 0"
# france.sh 挂着 trap on_error ERR；赋值 out=$(失败的命令) 会触发它、整个装机停下（09-28 真撞过，读回后面全跳了）
fresh
trapped=$(
  trap 'echo 陷阱响了' ERR
  set -E
  check_mirasim "$U" >/dev/null
  echo "返回 $? 待配 ${#PENDING[@]} 红 ${#REDS[@]}"
)
check "挂着 ERR 陷阱：陷阱没响、记一笔待配" "$trapped" "返回 0 待配 1 红 0"

echo "== 2. 目录在、一份令牌都没有：待配，同一条 fix"
install -d -o "$U" -g "$U" -m 755 "$DIR"
fresh
check_mirasim "$U" >/dev/null
check "记一笔待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
has "待配写清没有 local-<端口>.token" "$(last PENDING)" "还没有自己的 Mirasim 服务（没有 $DIR 下的 local-<端口>\.token）"

echo "== 3. 恰好一份：判绿，报端口；令牌内容不读"
SECRET="mirasim-token-secret-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s' "$SECRET" >"$T/token.tmp"
install -o "$U" -g "$U" -m 600 "$T/token.tmp" "$DIR/local-4173.token"
fresh
OUT3=$T/out3
check_mirasim "$U" >"$OUT3" 2>&1
check "判绿：没有待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "0 0"
has "报了文件和端口" "$(cat -- "$OUT3")" "$DIR/local-4173\.token（端口 4173"
has "写明内容没读" "$(cat -- "$OUT3")" "内容没读"
check "全部输出里搜不到令牌内容" "$(grep -cF -- "$SECRET" "$OUT3")" 0

echo "== 4. 不止一份：判红，列出文件名，说只该有一份"
install -o "$U" -g "$U" -m 600 /dev/null "$DIR/local-4174.token"
fresh
check_mirasim "$U" >/dev/null
check "判红、不是待配" "${#REDS[@]} ${#PENDING[@]}" "1 0"
has "红里列了两份文件名、说只该有一份" "$(last REDS)" "下有 2 份令牌.*local-4173\.token.*local-4174\.token.*只该有一份 Mirasim 服务"
rm -f -- "$DIR/local-4174.token"

echo "== 5. 目录真读不了（属主、权限不对，不是没有）：判红，和「目录不在」分开"
chown root:root -- "$DIR"
chmod 700 -- "$DIR"
fresh
check_mirasim "$U" >/dev/null
check "判红，没被错认成还没装" "${#REDS[@]} ${#PENDING[@]}" "1 0"
has "红里带 runuser 的退出码和报错，不是空的" "$(last REDS)" "查不了（runuser 退出 [0-9]+：.*Permission denied"
chown "$U:$U" -- "$DIR"
chmod 755 -- "$DIR"

echo "== 6. runuser 本身跑不起来（这个系统用户不存在）：判红，带着报错，不是空的"
fresh
check_mirasim "fleet-no-such-$$" >/dev/null
check "判红" "${#REDS[@]} ${#PENDING[@]}" "1 0"
has "红里不是空的" "$(last REDS)" "查不了（runuser 退出 [0-9]+：.+）"

echo "== 7. 换回好的：判绿（收尾核对，前面几步没有把状态搞坏）"
fresh
check_mirasim "$U" >/dev/null
check "判绿" "${#PENDING[@]} ${#REDS[@]}" "0 0"

if ((fail)); then
  echo "mirasim：不通过"
  exit 1
fi
echo "mirasim：通过"
