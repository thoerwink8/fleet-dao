#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 登录用户（法国的 pilot）的装与查，真建一个临时用户走一遍（deploy/lib/login-user.sh）：
#   1. 装两遍：第一遍建用户、加进看日志的组、从本地造的「发布」装 reclaude（sha256 照核），第二遍零改动；
#      装上的 reclaude 和它家里的东西都不归 root
#   2. 故意造错，看 check_login_user 拦不拦得下：拿出看日志的组、加 sudo 条目、多加一个组、reclaude 没执行位、
#      登录 shell 里找不到 reclaude、家目录权限不对、sudo 的回答认不出（没查成也算问题）、没有这个用户
#   3. 同时缺三样（组、家目录权限、reclaude），只补这三样；sha256 对不上的包不装
# 要 root：得建用户、组和 sudoers 条目（都是临时的，结束时删掉）。用法：sudo bash deploy/test/login-user.test.sh
# 退出码：0 通过，1 不通过，2 没跑成（不是 root、缺工具）。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/login-user.sh
source "$HERE/../lib/login-user.sh"

if ((EUID != 0)); then
  echo "没跑成：要 root（得建临时用户、组和 sudoers 条目）"
  exit 2
fi
for c in useradd userdel groupadd groupdel gpasswd usermod runuser visudo sudo curl setsid timeout; do
  if ! command -v "$c" >/dev/null; then
    echo "没跑成：这台没有 $c"
    exit 2
  fi
done

# 沙盒不放 /run：那里挂的是 noexec，test -x 和执行 reclaude 都会失败。临时用户的家也在沙盒里，得让它走得进去
T=$(mktemp -d /var/tmp/fleet-dao-login-test.XXXXXX)
chmod 755 "$T"
mkdir -m 755 "$T/home" "$T/dl"
TAG=fdt$$                                # 名字短：用户名最长 32 个字符
U=${TAG}p                                # 临时的登录用户
LOGIN_USER_LOG_GROUP=${TAG}j             # 顶替 systemd-journal，不动真组的成员
EXTRA=${TAG}x                            # 故意多加的组
SUDOERS=/etc/sudoers.d/${TAG}-login-test # 名字里不能带点，带了 sudo 不读
H=$T/home/$U
BIN=$H/.local/bin/reclaude
cleanup() {
  local g
  rm -f -- "$SUDOERS"
  userdel -r "$U" >/dev/null 2>&1
  for g in "$U" "$LOGIN_USER_LOG_GROUP" "$EXTRA"; do groupdel "$g" >/dev/null 2>&1; done
  rm -rf -- "$T"
}
trap cleanup EXIT
groupadd "$LOGIN_USER_LOG_GROUP"
groupadd "$EXTRA"

# 本地造的「发布」：curl 认 file://，sha256 现算
printf '#!/bin/sh\necho reclaude-fake\n' >"$T/dl/reclaude"
URL=file://$T/dl/reclaude
read -r SUM _ < <(sha256sum "$T/dl/reclaude")

fail=0
samples=0
pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}

# 装一遍：改动记进 CHANGES、红记进 REDS；装的过程打进日志，不通过时再看
run_setup() { # [sha256] [下载地址]
  CHANGES=()
  REDS=()
  setup_login_user "$U" "$H" "${2:-$URL}" "${1:-$SUM}" >>"$T/setup.log" 2>&1
}

# 查一次，比对拦下的代号（排好序、空格分隔；没给代号 = 应当干净）
expect() { # 说明 用户 要的代号…
  local what=$1 user=$2 rc got want l codes=()
  shift 2
  want="$*"
  check_login_user "$user"
  rc=$?
  for l in "${LOGIN_USER_BAD[@]}"; do codes+=("${l%%$'\t'*}"); done
  got=$(printf '%s\n' "${codes[@]}" | sort | xargs)
  if [[ "$got" == "$want" ]] && { [[ -z "$want" && "$rc" == 0 ]] || [[ -n "$want" && "$rc" == 1 ]]; }; then
    pass "$what：${want:-干净}"
  else
    flunk "$what：应为「${want:-干净}」，拦下的是「${got:-无}」（返回 $rc）"
    printf '      %s\n' "${LOGIN_USER_BAD[@]}"
  fi
}
violation() { # 同 expect，另记一个违规样本
  samples=$((samples + 1))
  expect "$@"
}

echo "== 1. 装两遍"
run_setup
if (($? == 0 && ${#REDS[@]} == 0 && ${#CHANGES[@]} >= 3)); then
  pass "第一遍改了 ${#CHANGES[@]} 处：$(printf '%s；' "${CHANGES[@]}")"
else
  flunk "第一遍没装成（红：${REDS[*]:-无}；改动 ${#CHANGES[@]} 处）"
fi
# 登录 shell 读哪份启动文件不靠这台 /etc/skel 的样子：bash 登录时只读 .bash_profile、.bash_login、.profile 里
# 头一个在的（CI 的镜像就带了别的，读不到 .profile）。只留 .profile，写成 Ubuntu 默认那几行，归这个用户
echo "  · 这台 /etc/skel 放进家里的：$(find "$H" -mindepth 1 -maxdepth 1 -printf '%f ')"
rm -f -- "$H/.bash_profile" "$H/.bash_login"
# shellcheck disable=SC2016 # 单引号里的东西要在登录 shell 里展开
printf '%s\n' 'if [ -d "$HOME/.local/bin" ] ; then' '    PATH="$HOME/.local/bin:$PATH"' 'fi' >"$H/.profile"
chown "$U:$U" "$H/.profile"
run_setup
if (($? == 0 && ${#REDS[@]} == 0 && ${#CHANGES[@]} == 0)); then pass "第二遍零改动"; else flunk "第二遍改了：${CHANGES[*]:-} ${REDS[*]:-}"; fi
if [[ "$(stat -c %U "$BIN" 2>/dev/null)" == "$U" && -z "$(find "$H" -user root 2>/dev/null)" ]]; then
  pass "reclaude 和家里的东西都归 $U，没有 root 属主的文件"
else
  flunk "reclaude 不归 $U，或家里有 root 属主的文件：$(find "$H" -user root 2>/dev/null | head -3 | tr '\n' ' ')"
fi
if [[ "$(cd / && runuser -u "$U" -- "$BIN" 2>&1)" == reclaude-fake ]]; then pass "$U 跑得起装上的 reclaude"; else flunk "$U 跑不起装上的 reclaude"; fi
expect "装完" "$U"

echo "== 2. 故意造错，自检要拦下"
gpasswd -d "$U" "$LOGIN_USER_LOG_GROUP" >/dev/null
violation "拿出看日志的组" "$U" no-log-group
usermod -a -G "$LOGIN_USER_LOG_GROUP" "$U"

printf '%s ALL=(root) NOPASSWD: /bin/false\n' "$U" >"$T/sudoers"
if visudo -cqf "$T/sudoers" >/dev/null 2>&1 && install -m 440 "$T/sudoers" "$SUDOERS"; then
  violation "加一条 sudo 条目" "$U" sudo
else
  flunk "造不出 sudo 条目（visudo 不认）"
fi
rm -f -- "$SUDOERS"

usermod -a -G "$EXTRA" "$U"
violation "多加一个组" "$U" extra-groups
gpasswd -d "$U" "$EXTRA" >/dev/null

chmod 644 "$BIN"
violation "reclaude 没有执行位" "$U" reclaude-noexec
run_setup
if ((${#REDS[@]})) && [[ "$(stat -c %a "$BIN")" == 644 ]]; then pass "装机不盖执行不了的 reclaude，判红"; else flunk "装机盖掉了执行不了的 reclaude，或没判红"; fi
chmod 755 "$BIN"

mv -- "$H/.profile" "$H/.profile.away"
violation "家里的 .profile 没了，登录 shell 里找不到 reclaude" "$U" reclaude-not-on-path
mv -- "$H/.profile.away" "$H/.profile"

chmod 755 "$H"
violation "家目录 755" "$U" home
chmod 750 "$H"

mv -- "$H" "$H.away"
violation "家目录没了（读不到也算问题）" "$U" home no-reclaude
mv -- "$H.away" "$H"

LOGIN_USER_SUDO=/bin/false
violation "sudo 的回答认不出（没查成）" "$U" sudo-unreadable
LOGIN_USER_SUDO=sudo

violation "没有这个用户" "${TAG}none" no-user
expect "造的错全撤掉之后" "$U"

echo "== 3. 只补缺的"
gpasswd -d "$U" "$LOGIN_USER_LOG_GROUP" >/dev/null
chmod 755 "$H"
rm -f -- "$BIN"
run_setup
if (($? == 0 && ${#REDS[@]} == 0 && ${#CHANGES[@]} == 3)); then
  pass "缺组、家目录权限、reclaude：补了这 3 处"
else
  flunk "应补 3 处，实际改了 ${#CHANGES[@]} 处（${CHANGES[*]:-}），红：${REDS[*]:-无}"
fi
expect "补完" "$U"
rm -f -- "$BIN"
run_setup "$SUM" "file://$T/dl/none"
if ((${#REDS[@]})) && [[ ! -e "$BIN" ]]; then pass "下载失败：判红，不装"; else flunk "下载失败没判红，或装了东西"; fi
run_setup 0000000000000000000000000000000000000000000000000000000000000000
left=$(find "$H/.local/bin" -mindepth 1 2>&1)
if ((${#REDS[@]})) && [[ -z "$left" ]]; then
  pass "sha256 对不上：判红，不装、不留半截"
else
  flunk "sha256 对不上也装了，或留了东西：${left:-（没判红）}"
fi

if ((fail)); then
  echo "不通过。装的过程："
  cat "$T/setup.log"
  exit 1
fi
echo "通过：$samples 个违规样本全部拦下；装两遍第二遍零改动；缺的只补缺的；下载失败、sha256 对不上都不装"
