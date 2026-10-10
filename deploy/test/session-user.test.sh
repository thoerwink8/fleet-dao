#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 法国的会话用户（deploy/lib/session-user.sh）：只有一个、读回的判据拦不拦得下故意造的错。不要 root、不建真账号：
# getent / sudo -l / id 三样换成假的，家目录在临时目录里造。
#   1. 只有一个会话用户 fleet-agent-carpool；france.sh 不建、不查停用的 fleet-agent-dedicated（重新加回来这里会红）
#   2. 干净的家 + 登录过：两条都绿，没有红和待配
#   3. 故意造错：家目录不在 /home/<用户>、是符号链接、属主或权限不对、有 sudo 条目、多一个组、用户不在——都判红，不当成没事
#   3b. ~/.ssh（#1785）：不在或是空目录判绿；里面有任何东西（#1773 那几样）、是链接或文件都判红
#   3c. 登录口子 /etc/ssh/authorized_keys/<用户>：只放创始人登录 pilot 的钥匙、root:root 644 判绿；多一把别人的、认不出、权限或属主不对、
#       pilot 那份读不了——都判红；还没放记待配
#   3d. 装机收口 quarantine_session_ssh：多余文件和钥匙挪进隔离目录（只挪不删）、记 changed、再跑不动、挪不成判红
#   3e. 出站 22：读回认「被立刻拒」才绿，连上判红，路不通记待配；渲染后的 nft 里有只限会话用户的 22 拒绝
#   4. 没装 reclaude：红（france.sh 该装，引擎起不了会话）；装了没登录：记「待配」，不判绿
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
eq() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then pass "$1"; else flunk "$1：实际「$2」，应为「$3」"; fi
}
flunk() {
  echo "  ✗ $*"
  fail=1
}

# 假的三样：家目录按 FAKE_HOME，sudo -l 和组按 FAKE_SUDO / FAKE_GROUPS 答
FAKE_HOME=""
FAKE_SUDO=""
FAKE_GROUPS=""
FAKE_META=""
SESSION_USER_HOME_ROOT=$T/home
mkdir -p "$SESSION_USER_HOME_ROOT"
session_user_home() { printf '%s' "$FAKE_HOME"; }
session_user_home_meta() { printf '%s' "$FAKE_META"; }
session_user_sudo_list() { printf '%s' "$FAKE_SUDO"; }
session_user_groups() { printf '%s' "$FAKE_GROUPS"; }
# 属主换成假的（测试不是 root，建不出归会话用户的文件），权限照真的读
FAKE_SSH_OWNER="root:root"
session_user_path_meta() { printf '%s %s' "$FAKE_SSH_OWNER" "$(stat -c %a -- "$1")"; }
# 登录口子（/etc/ssh/authorized_keys）和隔离目录都换成临时目录；默认放一份空的钥匙文件（root:root 644），免得每一条都带「还没放」的待配
SESSION_SSH_KEYS_DIR=$T/etc-ssh-keys
SESSION_QUARANTINE_ROOT=$T/quarantine
session_user_today() { echo 2026-10-11; }
mkdir -p "$SESSION_SSH_KEYS_DIR"
: >"$SESSION_SSH_KEYS_DIR/$SESSION_USER"
chmod 644 "$SESSION_SSH_KEYS_DIR/$SESSION_USER"

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
FAKE_HOME=$SESSION_USER_HOME_ROOT/$U
FAKE_SUDO="User $U is not allowed to run sudo on france."
FAKE_GROUPS=$U
FAKE_META="$U:$U 750"
clean_home "$FAKE_HOME" 1
check "没有 sudo、只在自己的组里、没有凭据、reclaude 已登录：两条都绿" 0 0 2

echo "== 3. 故意造错：都判红"
FAKE_META="$U:$U 755"
check "家目录 755（别人读得到登录态）：红" 1 0 1 "要 $U:$U 750"
FAKE_META="root:root 750"
check "家目录归 root：红" 1 0 1 "要 $U:$U 750"
FAKE_META=""
check "家目录的属主权限读不到：红，不当成对" 1 0 1 "读不到"
FAKE_META="$U:$U 750"
mkdir -p "$T/elsewhere"
ln -s "$T/elsewhere" "$T/linked"
FAKE_HOME=$T/linked
check "家目录不在 /home/<用户>：红" 1 0 0 "不是 $SESSION_USER_HOME_ROOT/$U"
# 符号链接放在另一个假的 /home 下，不动上面那个真目录
mkdir -p "$T/altroot" "$T/real-home"
ln -s "$T/real-home" "$T/altroot/$U"
if [[ -L "$T/altroot/$U" ]]; then
  SESSION_USER_HOME_ROOT=$T/altroot FAKE_HOME=$T/altroot/$U check "家目录是符号链接：红" 1 0 0 "是符号链接"
else
  echo "  （这台建不了真的符号链接，跳过这一条；CI 的 Linux 上会跑）"
fi
FAKE_HOME=$SESSION_USER_HOME_ROOT/$U
FAKE_SUDO="User $U may run the following commands on france: (ALL) NOPASSWD: ALL"
check "有 sudo 条目：红" 1 0 1 "有 sudo 条目"
FAKE_SUDO="User $U is not allowed to run sudo on france."
FAKE_GROUPS="$U fleet"
check "多在一个组里：红" 1 0 1 "附加组「$U fleet」"
FAKE_GROUPS=$U

echo "== 3b. ~/.ssh：不在或是空目录才对；里面有任何东西都判红"
mkdir -p "$FAKE_HOME"
rm -rf -- "$FAKE_HOME/.ssh"
check "没有 ~/.ssh：绿" 0 0 2
mkdir -p "$FAKE_HOME/.ssh"
chmod 700 "$FAKE_HOME/.ssh"
check "空的 ~/.ssh：绿" 0 0 2
put_ssh_dir() { # 文件名… （都放成内容随便的普通文件）
  rm -rf -- "$FAKE_HOME/.ssh"
  mkdir -p "$FAKE_HOME/.ssh"
  local n
  for n in "$@"; do echo x >"$FAKE_HOME/.ssh/$n"; done
}
put_ssh_dir config fleet_login fleet_login.pub known_hosts authorized_keys
check "【故意造出的失败】#1773 那几样（config、私钥、known_hosts、authorized_keys）：红，点名" 1 0 1 "有 authorized_keys config fleet_login"
put_ssh_dir authorized_keys
check "【故意造出的失败】只剩 authorized_keys 也是红（登录口子不在家里）：红" 1 0 1 "有 authorized_keys"
put_ssh_dir .hidden
check "【故意造出的失败】只有隐藏文件：红" 1 0 1 "有 .hidden"
rm -rf -- "$FAKE_HOME/.ssh"
ln -s "$T/elsewhere" "$FAKE_HOME/.ssh" 2>/dev/null
if [[ -L "$FAKE_HOME/.ssh" ]]; then
  check "【故意造出的失败】~/.ssh 是链接：红" 1 0 1 "不是目录"
else
  echo "  （这台建不了真的符号链接，跳过这一条；CI 的 Linux 上会跑）"
fi
rm -rf -- "$FAKE_HOME/.ssh"
printf 'x' >"$FAKE_HOME/.ssh"
check "【故意造出的失败】~/.ssh 是个文件：红" 1 0 1 "不是目录"
rm -rf -- "$FAKE_HOME/.ssh"

echo "== 3c. 登录口子 /etc/ssh/authorized_keys/<用户>：只许放创始人登录 pilot 的钥匙，root:root 644"
if ! command -v ssh-keygen >/dev/null; then
  flunk "这台没有 ssh-keygen，3c 没跑成（读回在法国上要用它认钥匙）"
else
  ssh-keygen -q -t ed25519 -N '' -C founder -f "$T/founder" >/dev/null
  ssh-keygen -q -t ed25519 -N '' -C stranger -f "$T/stranger" >/dev/null
  mkdir -p "$T/pilot-ssh"
  SESSION_SSH_ALLOW_FILE=$T/pilot-ssh/authorized_keys
  cp "$T/founder.pub" "$SESSION_SSH_ALLOW_FILE"
  put_keys() { # 公钥文件…（一个不给就是空文件）
    mkdir -p "$SESSION_SSH_KEYS_DIR"
    : >"$SESSION_SSH_KEYS_DIR/$U"
    local k
    for k in "$@"; do cat -- "$k" >>"$SESSION_SSH_KEYS_DIR/$U"; done
    chmod 644 "$SESSION_SSH_KEYS_DIR/$U"
  }
  rm -rf -- "$SESSION_SSH_KEYS_DIR"
  check "钥匙文件还没放：待配，不判红" 0 1 2 "还没放"
  put_keys "$T/founder.pub"
  check "只放了创始人登录 pilot 的那把：绿" 0 0 2
  put_keys
  check "文件是空的：绿" 0 0 2
  {
    echo '# 注释'
    echo 'restrict,port-forwarding '"$(cat "$T/founder.pub")"
  } >"$SESSION_SSH_KEYS_DIR/$U"
  check "那把钥匙前面带了限制选项、还有注释行：照样认得，绿" 0 0 2
  put_keys "$T/founder.pub" "$T/stranger.pub"
  check "【故意造出的失败】多了一把 pilot 家里没有的：红" 1 0 1 "有 1 把钥匙不在"
  put_keys "$T/founder.pub"
  echo 'ssh-ed25519 这不是钥匙 x' >>"$SESSION_SSH_KEYS_DIR/$U"
  check "【故意造出的失败】有一行认不出：红，不当成只有认得的那几把" 1 0 1 "认不全"
  put_keys "$T/founder.pub"
  chmod 664 "$SESSION_SSH_KEYS_DIR/$U"
  if [[ "$(stat -c %a "$SESSION_SSH_KEYS_DIR/$U")" == 664 ]]; then
    check "【故意造出的失败】钥匙文件是 664（会话用户若在组里能改）：红" 1 0 1 "要 root:root 644"
  else
    echo "  （这台的文件系统不认 chmod 664，跳过这一条；CI 的 Linux 上会跑）"
  fi
  put_keys "$T/founder.pub"
  FAKE_SSH_OWNER="$U:$U"
  check "【故意造出的失败】钥匙文件归会话用户自己（它改得了）：红" 1 0 1 "要 root:root 644"
  FAKE_SSH_OWNER="root:root"
  rm -f -- "$SESSION_SSH_KEYS_DIR/$U"
  ln -s "$T/founder.pub" "$SESSION_SSH_KEYS_DIR/$U" 2>/dev/null
  if [[ -L "$SESSION_SSH_KEYS_DIR/$U" ]]; then
    check "【故意造出的失败】钥匙文件是链接：红" 1 0 1 "是链接"
  else
    echo "  （这台建不了真的符号链接，跳过这一条；CI 的 Linux 上会跑）"
  fi
  put_keys "$T/founder.pub"
  SESSION_SSH_ALLOW_FILE=$T/nowhere/authorized_keys
  check "【故意造出的失败】pilot 那份读不到：红，核对不了不当成对" 1 0 1 "核对不了"
  SESSION_SSH_ALLOW_FILE=$T/pilot-ssh/authorized_keys
  : >"$SESSION_SSH_ALLOW_FILE"
  check "【故意造出的失败】pilot 那份是空的：红" 1 0 1 "核对不了"
  cp "$T/founder.pub" "$SESSION_SSH_ALLOW_FILE"
  put_keys
fi

echo "== 3d. 装机时收口：~/.ssh 里的东西挪进 /root/quarantine/<用户>-ssh-<日期>/，只挪不删，记 changed"
FAKE_HOME=$SESSION_USER_HOME_ROOT/$U
clean_home "$FAKE_HOME" 1
put_ssh_dir config fleet_login fleet_login.pub known_hosts authorized_keys
echo 'ssh-ed25519 AAAA 多出来的钥匙' >"$FAKE_HOME/.ssh/authorized_keys"
CHANGES=() REDS=()
quarantine_session_ssh "$U" "$FAKE_HOME" >/dev/null
Q=$SESSION_QUARANTINE_ROOT/$U-ssh-2026-10-11
eq "家里的 .ssh 没了" "$([[ -e "$FAKE_HOME/.ssh" ]] && echo 在 || echo 没有)" 没有
eq "整份进了隔离目录（五个文件一个没少）" "$(find "$Q/dot-ssh" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort | tr '\n' ' ')" "authorized_keys config fleet_login fleet_login.pub known_hosts "
eq "多出来的钥匙原样在隔离目录里（没删）" "$(cat "$Q/dot-ssh/authorized_keys" 2>/dev/null)" 'ssh-ed25519 AAAA 多出来的钥匙'
(umask 077 && mkdir -p "$T/umask-ref")
if [[ "$(stat -c %a "$T/umask-ref")" == 700 ]]; then
  eq "隔离目录 700（里面是会话用户的私钥）" "$(stat -c %a "$Q" 2>/dev/null)" 700
else
  echo "  （这台的文件系统不认 umask，跳过隔离目录权限这一条；CI 的 Linux 上会跑）"
fi
eq "记了一笔 changed，点名这几个文件和去处" "${#CHANGES[@]} $(grep -c "config.*$Q/dot-ssh" <<<"${CHANGES[*]}")" "1 1"
eq "没有红" "${#REDS[@]}" 0
CHANGES=()
quarantine_session_ssh "$U" "$FAKE_HOME" >/dev/null
eq "再跑一遍：~/.ssh 已经不在，什么都不动、不记 changed" "${#CHANGES[@]}" 0
mkdir -p "$FAKE_HOME/.ssh"
quarantine_session_ssh "$U" "$FAKE_HOME" >/dev/null
eq "空的 ~/.ssh：不动、不记 changed" "${#CHANGES[@]} $([[ -d "$FAKE_HOME/.ssh" ]] && echo 在 || echo 没有)" "0 在"
put_ssh_dir authorized_keys
quarantine_session_ssh "$U" "$FAKE_HOME" >/dev/null
eq "同一天再来一次：不覆盖上一次的，放进 -2" "$([[ -f "$Q-2/dot-ssh/authorized_keys" && -f "$Q/dot-ssh/config" ]] && echo 都在 || echo 缺)" 都在
rm -rf -- "$FAKE_HOME/.ssh"
ln -s "$T/elsewhere" "$FAKE_HOME/.ssh" 2>/dev/null
if [[ -L "$FAKE_HOME/.ssh" ]]; then
  quarantine_session_ssh "$U" "$FAKE_HOME" >/dev/null
  check "家里的 .ssh 是链接：链接本身挪走（不跟着它去动别处）" "$([[ -L "$Q-3/dot-ssh" && -d "$T/elsewhere" ]] && echo 是 || echo 否)" 是
else
  echo "  （这台建不了真的符号链接，跳过这一条；CI 的 Linux 上会跑）"
  rm -rf -- "$FAKE_HOME/.ssh"
fi
eq "挪完 check_session_ssh 不报" "$(
  check_session_ssh "$U" "$FAKE_HOME"
  echo "[$SSH_BAD]"
)" "[]"
put_ssh_dir authorized_keys
SESSION_QUARANTINE_ROOT=/proc/不可写
REDS=()
rc=0
quarantine_session_ssh "$U" "$FAKE_HOME" >/dev/null 2>&1 || rc=$?
eq "【故意造出的失败】挪不成（隔离目录建不了）：返回 1、判红、原件还在" "$rc ${#REDS[@]} $([[ -f "$FAKE_HOME/.ssh/authorized_keys" ]] && echo 在 || echo 没了)" "1 1 在"
SESSION_QUARANTINE_ROOT=$T/quarantine
rm -rf -- "$FAKE_HOME/.ssh"

echo "== 3e. 出站 22：会话用户连香港 sshd 要被立刻拒（读回），nft 规则文本里有 22 的拒绝"
# shellcheck source=../lib/session-ports.sh
source "$DEPLOY/lib/session-ports.sh"
PROBE_OUT="" PROBE_RC=0
session_ssh_probe() {
  printf '%s' "$PROBE_OUT"
  return "$PROBE_RC"
}
id() {
  if [[ "$1" == -u && "$2" == -- && "$3" == nobody-here ]]; then return 1; fi
  return 0
}
egress() { # 说明 红 待配 绿 [要出现的字]
  local what=$1 r=$2 p=$3 o=$4 want=${5:-} out oks all
  REDS=()
  PENDING=()
  out=$(check_session_ssh_egress "$U" 10.99.0.1)
  check_session_ssh_egress "$U" 10.99.0.1 >/dev/null
  oks=$(grep -c '✓' <<<"$out")
  all="${REDS[*]} ${PENDING[*]}"
  if ((${#REDS[@]} == r && ${#PENDING[@]} == p && oks == o)) && [[ -z "$want" || "$all" == *"$want"* ]]; then
    pass "$what"
  else
    flunk "$what：红 ${#REDS[@]}（要 $r）、待配 ${#PENDING[@]}（要 $p）、绿 $oks（要 $o）；输出「$out」"
  fi
}
PROBE_OUT=$'ran\nbash: connect: Connection refused\nbash: /dev/tcp/10.99.0.1/22: Connection refused' PROBE_RC=1
egress "被立刻拒（Connection refused）：绿" 0 0 1
PROBE_OUT=$'ran' PROBE_RC=0
egress "【故意造出的失败】连上了：红" 1 0 0 "连得上 10.99.0.1:22"
PROBE_OUT=$'ran' PROBE_RC=124
egress "【故意造出的失败】等满时限没答（可能路不通）：待配，不当成挡住了" 0 1 0 "不是被拒"
PROBE_OUT=$'ran\nbash: connect: Network is unreachable' PROBE_RC=1
egress "【故意造出的失败】Network is unreachable：待配，不当成挡住了" 0 1 0 "不是被拒"
PROBE_OUT='' PROBE_RC=1
egress "【故意造出的失败】没以会话用户的身份跑起来：待配" 0 1 0 "没以"
REDS=()
PENDING=()
check_session_ssh_egress nobody-here 10.99.0.1 >/dev/null
eq "【故意造出的失败】查不到会话用户：待配" "${#REDS[@]} ${#PENDING[@]}" "0 1"
render "$DEPLOY/france/fleet-dao.nft" PORTS=5432 FLEET_UID=1001 SESSION_UID=1002
NFT_TEXT=$RENDERED
if grep -qE '^[[:space:]]*meta skuid 1002 tcp dport 22 reject' <<<"$NFT_TEXT"; then
  pass "渲染后的 nft 里有「meta skuid <会话用户> tcp dport 22 reject」"
else
  flunk "渲染后的 fleet-dao.nft 里没有会话用户出站 22 的拒绝"
fi
if grep -E 'tcp dport 22 ' <<<"$NFT_TEXT" | grep -v '^[[:space:]]*#' | grep -vq 'meta skuid 1002'; then
  flunk "22 的拒绝没限定在会话用户上（会挡到 root 和引擎）"
else
  pass "22 的拒绝只限定会话用户（root、fleet 不受影响）"
fi
if grep -E 'dport 22 ' <<<"$NFT_TEXT" | grep -v '^[[:space:]]*#' | grep -qE 'skuid (!=|\{)'; then
  flunk "22 的拒绝写成了「不是某某」，会连带别人"
else
  pass "22 的拒绝按「就是会话用户」写，不是按「不是谁」排除"
fi
unset -f id
FAKE_HOME=""
check "用户不在（getent 查不到）：红，不当成没事" 1 0 0 "不在"

echo "== 4. 没装：红；没登录：待配，不判绿"
FAKE_HOME=$SESSION_USER_HOME_ROOT/$U
clean_home "$FAKE_HOME" 0
check "装了 reclaude 没登录：待配" 0 1 1 "还没登录"
rm -f -- "$FAKE_HOME/.local/bin/reclaude"
check "新机器上会话用户缺 reclaude：红（引擎起不了 Claude 会话）" 1 0 1 "没有 reclaude 二进制"
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
