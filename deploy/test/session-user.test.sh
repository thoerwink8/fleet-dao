#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 法国的会话用户（deploy/lib/session-user.sh）：只有一个、读回的判据拦不拦得下故意造的错。不要 root、不建真账号：
# getent / sudo -l / id 三样换成假的，家目录在临时目录里造。
#   1. 只有一个会话用户 fleet-agent-carpool；france.sh 不建、不查停用的 fleet-agent-dedicated（重新加回来这里会红）
#   2. 干净的家 + 登录过：两条都绿，没有红和待配
#   3. 故意造错：有 sudo 条目、多一个组、家里有 ~/.ssh、用户不在——都判红，不当成没事
#   4. 没装 reclaude、装了没登录：记「待配」，不判绿
#   5. pilot 不登录 reclaude：它的判据（lib/login-user.sh）不看登没登录
# 用法：bash deploy/test/session-user.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
# shellcheck source=../lib/common.sh
source "$DEPLOY/lib/common.sh"
# shellcheck source=../lib/session-user.sh
source "$DEPLOY/lib/session-user.sh"

T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
fail=0
pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}

# 假的三样：家目录按 FAKE_HOME，sudo -l 和组按 FAKE_SUDO / FAKE_GROUPS 答
FAKE_HOME=""
FAKE_SUDO=""
FAKE_GROUPS=""
session_user_home() { printf '%s' "$FAKE_HOME"; }
session_user_sudo_list() { printf '%s' "$FAKE_SUDO"; }
session_user_groups() { printf '%s' "$FAKE_GROUPS"; }

U=$SESSION_USER
clean_home() { # 家目录 登录过没有（1/0）
  rm -rf -- "$1"
  mkdir -p "$1/.local/bin"
  printf '#!/bin/sh\n' >"$1/.local/bin/reclaude"
  chmod 755 "$1/.local/bin/reclaude"
  if (($2)); then
    mkdir -p "$1/.reclaude"
    echo '{"device":"x"}' >"$1/.reclaude/device.json"
  fi
}
# 跑一次读回，比对红、待配、绿各几条；want_text 给了就要在红或待配里出现
check() { # 说明 红几条 待配几条 绿几条 [要出现的字]
  local what=$1 r=$2 p=$3 o=$4 want=${5:-} out oks all
  REDS=()
  PENDING=()
  out=$(readback_session_user "$U")
  readback_session_user "$U" >/dev/null
  oks=$(grep -c '✓' <<<"$out")
  all="${REDS[*]} ${PENDING[*]}"
  if ((${#REDS[@]} == r && ${#PENDING[@]} == p && oks == o)) && [[ -z "$want" || "$all" == *"$want"* ]]; then
    pass "$what"
  else
    flunk "$what：红 ${#REDS[@]}（要 $r）、待配 ${#PENDING[@]}（要 $p）、绿 $oks（要 $o）；输出「$out」"
  fi
}

echo "== 1. 只有一个会话用户"
if [[ "$SESSION_USER" == fleet-agent-carpool ]]; then
  pass "会话用户是 fleet-agent-carpool（历史沿用的名字，不改名免得重新登录）"
else
  flunk "会话用户应是 fleet-agent-carpool，读到「$SESSION_USER」"
fi
# shellcheck disable=SC2016 # 要找的就是字面的 $SESSION_USER（不在这里展开）
if grep -qxF 'SESSION_USERS=("$SESSION_USER")' "$DEPLOY/france.sh"; then
  pass "france.sh 建和读回的会话用户只有这一个"
else
  flunk "france.sh 的 SESSION_USERS 应当只有 \$SESSION_USER"
fi
# 停用的用户只许出现在注释里（说明它已停用），不许回到要建、要查的名单里
if grep -n 'fleet-agent-dedicated' "$DEPLOY/france.sh" "$DEPLOY/lib/"*.sh "$DEPLOY/france/"*.sh | grep -v ':[0-9]*:#' | grep -q .; then
  flunk "装机脚本里还有不在注释里的 fleet-agent-dedicated：$(grep -n 'fleet-agent-dedicated' "$DEPLOY/france.sh" "$DEPLOY/lib/"*.sh "$DEPLOY/france/"*.sh | grep -v ':[0-9]*:#' | head -3)"
else
  pass "装机脚本不再建、不再查 fleet-agent-dedicated（只在注释里说它已停用）"
fi

echo "== 2. 干净、登录过"
FAKE_HOME=$T/home-ok
FAKE_SUDO="User $U is not allowed to run sudo on france."
FAKE_GROUPS=$U
clean_home "$FAKE_HOME" 1
check "没有 sudo、只在自己的组里、没有凭据、reclaude 已登录：两条都绿" 0 0 2

echo "== 3. 故意造错：都判红"
FAKE_SUDO="User $U may run the following commands on france: (ALL) NOPASSWD: ALL"
check "有 sudo 条目：红" 1 0 1 "有 sudo 条目"
FAKE_SUDO="User $U is not allowed to run sudo on france."
FAKE_GROUPS="$U fleet"
check "多在一个组里：红" 1 0 1 "附加组「$U fleet」"
FAKE_GROUPS=$U
mkdir -p "$FAKE_HOME/.ssh"
check "家里有 ~/.ssh：红" 1 0 1 "家里有 ~/.ssh"
rm -rf -- "$FAKE_HOME/.ssh"
FAKE_HOME=""
check "用户不在（getent 查不到）：红，不当成没事" 1 0 0 "不在"

echo "== 4. 没装、没登录：待配，不判绿"
FAKE_HOME=$T/home-nologin
clean_home "$FAKE_HOME" 0
check "装了 reclaude 没登录：待配" 0 1 1 "还没登录"
rm -f -- "$FAKE_HOME/.local/bin/reclaude"
check "没装 reclaude：待配" 0 1 1 "还没有 reclaude 二进制"
mkdir -p "$FAKE_HOME/.reclaude"
: >"$FAKE_HOME/.reclaude/device.json"
printf '#!/bin/sh\n' >"$FAKE_HOME/.local/bin/reclaude"
chmod 755 "$FAKE_HOME/.local/bin/reclaude"
check "device.json 是空的：算没登录" 0 1 1 "还没登录"

echo "== 5. pilot 不登录 reclaude"
if grep -q 'device\.json' "$DEPLOY/lib/login-user.sh"; then
  flunk "lib/login-user.sh 在看 reclaude 登没登录（device.json）：pilot 不登录 reclaude，不该查"
else
  pass "pilot 的读回不看 reclaude 登没登录"
fi

if ((fail)); then
  echo "不通过"
  exit 1
fi
echo "通过"
