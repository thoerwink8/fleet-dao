#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034,SC2317,SC2329 # 桩函数和被 source 进来的 human-tier.sh 用到的变量，shellcheck 看不出
# 法国 sshd 抗扫描和 fail2ban 的 sshd jail（#1348，deploy/lib/human-tier.sh 的 setup_sshd_hardening、setup_fail2ban_sshd 和它们的读回）。
# 不要 root、不要 sshd、fail2ban：sshd、systemctl、fail2ban-client 都换成桩，文件放进临时目录，只看流程和判据：
#   1. 仓里的 drop-in 只有三项设置（LoginGraceTime 20、MaxStartups 30:30:120、MaxAuthTries 3），不碰端口和认证方式，没写 9.6 认不得的 PerSourcePenalties
#   2. sshd：首次装 → 放文件、sshd -t、reload；再跑一遍什么都不动；
#      【故意造出的失败】sshd -t 不过 → 文件撤掉、不 reload、判红；reload 失败 → 判红（文件留着）；目录不在、没有 sshd 命令 → 判红
#   3. sshd 读回：有效配置三项对 → 全绿；【故意造出的失败】值被别处盖掉、sshd -T 读不出、文件被改 → 判红
#   4. fail2ban：没装 → 只记待配（不放文件、不判红）；装了 → 放文件、-t、reload，再跑一遍不动；
#      【故意造出的失败】-t 不过 → 文件撤掉、不 reload、判红；没在跑 → 待配、不 reload；reload 失败 → 判红
#   7. 会话用户的登录口子收口（#1785，setup_session_ssh、readback_session_ssh_scope）：~/.ssh 挪进隔离目录（只挪不删、再来放 -2）、钥匙文件照 pilot 写、
#      Match User drop-in 放好、sshd -t 过了才 reload、再跑不动；【故意造出的失败】sshd -t 不过撤掉、pilot 那份读不到、没有 sshd；
#      读回：有效配置里会话用户认 /etc 下那份、Match 段没漏到 pilot，没生效、漏了、读不出、drop-in 被改都判红
#   5. fail2ban 读回：四项对 → 全绿；【故意造出的失败】值不对、jail 不在 → 判红；fail2ban-client 答不出 → 待配（不当成对了）
# 用法：bash deploy/test/sshd-hardening.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/human-tier.sh
source "$HERE/../lib/human-tier.sh"
# shellcheck source=../lib/session-user.sh
source "$HERE/../lib/session-user.sh"

DEPLOY_DIR=$(cd -- "$HERE/.." && pwd)
for f in france/sshd-hardening.conf france/fail2ban-sshd.jail; do
  if [[ ! -s "$DEPLOY_DIR/$f" ]]; then
    echo "sshd-hardening：没跑成：仓里没有 deploy/$f"
    exit 2
  fi
done

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
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
# 桩在 $(…) 里被调，数组记不住：调用记在文件里，一行一条
CALLS_FILE=$TMP/calls
: >"$CALLS_FILE"
record() { printf '%s\n' "$*" >>"$CALLS_FILE"; }
calls() { tr '\n' ' ' <"$CALLS_FILE" | sed 's/ $//'; }       # 所有调用，空格连起来
ncalls() { wc -l <"$CALLS_FILE" | tr -d ' '; }               # 一共几条
count() { grep -c -- "$1" "$CALLS_FILE" || true; }           # 含某段的有几条
fresh() {
  CHANGES=() REDS=() PENDING=()
  : >"$CALLS_FILE"
}
mkdir -p "$TMP/sshd_config.d" "$TMP/jail.d"
SSHD_HARDENING_DROPIN=$TMP/sshd_config.d/50-fleet-dao-hardening.conf
FAIL2BAN_SSHD_JAIL=$TMP/jail.d/fleet-dao-sshd.local
SSHD_CONF=$DEPLOY_DIR/france/sshd-hardening.conf
F2B_CONF=$DEPLOY_DIR/france/fail2ban-sshd.jail

# ── 桩：只记调用，不碰机器 ──
SSHD_T_RC=0
SSHD_T_ERR_OUT="/etc/ssh/sshd_config.d/50-fleet-dao-hardening.conf line 3: Bad configuration option: PerSourcePenalties"
SSHD_RELOAD_RC=0
SSHD_ABSENT=0
SSHD_EFFECTIVE_RC=0
declare -A SSHD_AKF=()
SSHD_EFFECTIVE=$'port 22\nlogingracetime 20\nmaxauthtries 3\nmaxstartups 30:30:120\npasswordauthentication no'
F2B_ABSENT=0
F2B_ACTIVE=active
F2B_T_RC=0
F2B_RELOAD_RC=0
F2B_STATUS_RC=0
declare -A F2B_GET=([maxretry]=3 [findtime]=600 [bantime]=3600 [bantime.increment]=True)

# command -v 找得到函数；要演示「没装」就让它答没有
command() {
  if [[ "${1:-}" == -v && "${2:-}" == sshd && $SSHD_ABSENT == 1 ]]; then return 1; fi
  if [[ "${1:-}" == -v && "${2:-}" == fail2ban-client && $F2B_ABSENT == 1 ]]; then return 1; fi
  builtin command "$@"
}
sshd() {
  record "sshd $*"
  case "$1" in
  -t)
    if ((SSHD_T_RC)); then echo "$SSHD_T_ERR_OUT" >&2; fi
    return "$SSHD_T_RC"
    ;;
  -T)
    if [[ "${2:-}" == -C ]]; then
      # sshd -T -C user=<用户>,host=…：只回这一个用户认钥匙的文件（SSHD_AKF[用户]）
      local who=${3#user=}
      who=${who%%,*}
      if ((SSHD_EFFECTIVE_RC)); then
        echo "sshd -T -C 跑不成" >&2
        return "$SSHD_EFFECTIVE_RC"
      fi
      printf 'port 22\nauthorizedkeysfile %s\n' "${SSHD_AKF[$who]:-}"
      return 0
    fi
    printf '%s\n' "$SSHD_EFFECTIVE"
    return "$SSHD_EFFECTIVE_RC"
    ;;
  esac
}
systemctl() {
  case "$1 $2" in
  "is-active fail2ban.service")
    echo "$F2B_ACTIVE"
    [[ "$F2B_ACTIVE" == active ]]
    return
    ;;
  esac
  record "systemctl $*"
  if [[ "$1" == reload && "$2" == ssh.service ]]; then
    if ((SSHD_RELOAD_RC)); then echo "reload failed" >&2; fi
    return "$SSHD_RELOAD_RC"
  fi
}
fail2ban-client() {
  record "fail2ban-client $*"
  case "$1" in
  -t)
    if ((F2B_T_RC)); then echo "ERROR bad jail" >&2; fi
    return "$F2B_T_RC"
    ;;
  reload) return "$F2B_RELOAD_RC" ;;
  status)
    if ((F2B_STATUS_RC)); then echo "Sorry but the jail 'sshd' does not exist" >&2; fi
    return "$F2B_STATUS_RC"
    ;;
  get)
    if [[ -n "${F2B_GET[$3]:-}" ]]; then
      printf '%s\n' "${F2B_GET[$3]}"
    else
      echo "ERROR: unknown command" >&2
      return 1
    fi
    ;;
  esac
}
# 和 common.sh 的 put_file 同一个判法（内容一样不动、WROTE 记有没有写），只是不 chown/chmod（不要 root）
put_file() { # 目标 属主:组 权限 内容
  local dest=$1 content=$4
  WROTE=0
  if [[ -f "$dest" ]] && cmp -s -- "$dest" <(printf '%s\n' "$content"); then return 0; fi
  printf '%s\n' "$content" >"$dest"
  changed "写 $dest"
}

echo "== 1. 仓里的 drop-in：只有那三项设置"
settings=$(grep -vE '^[[:space:]]*(#|$)' "$SSHD_CONF" | tr -d '\r')
check "非注释行恰好是三项" "$settings" $'LoginGraceTime 20\nMaxStartups 30:30:120\nMaxAuthTries 3'
check "没碰端口、认证方式、没写 9.6 认不得的 PerSourcePenalties" \
  "$(grep -cEi '^[[:space:]]*(Port|PasswordAuthentication|PubkeyAuthentication|PermitRootLogin|PerSourcePenalties)\b' "$SSHD_CONF" || true)" 0
has "注释里写明了没写 PerSourcePenalties 的原因" "$(<"$SSHD_CONF")" 'PerSourcePenalties.*9\.8'
f2b=$(grep -vE '^[[:space:]]*(#|$)' "$F2B_CONF" | tr -d '\r')
check "fail2ban jail：只有 [sshd] 一段、六项设置（含 ignoreip）" "$f2b" $'[sshd]\nenabled = true\nmaxretry = 3\nfindtime = 10m\nbantime = 1h\nbantime.increment = true\nignoreip = 127.0.0.1/8 ::1 10.99.0.0/24'

echo "== 2. sshd：首次装 → 放文件、sshd -t、reload；再跑一遍什么都不动"
fresh
setup_sshd_hardening >/dev/null
check "文件放对了（和仓里一样）" "$(cmp -s -- "$SSHD_HARDENING_DROPIN" "$SSHD_CONF" && echo 一样 || echo 不一样)" 一样
check "调用顺序：先 sshd -t 再 reload ssh.service" "$(calls)" "sshd -t systemctl reload ssh.service"
has "记了重载" "${CHANGES[*]}" "重载 sshd"
check "没有红、没有待配" "${#REDS[@]} ${#PENDING[@]}" "0 0"
fresh
setup_sshd_hardening >/dev/null
check "第二遍：没有改动记录、没有任何调用（不验、不重载）" "${#CHANGES[@]} $(ncalls)" "0 0"

echo "== 2b.【故意造出的失败】sshd -t 不过：文件撤掉、不 reload、判红"
rm -f -- "$SSHD_HARDENING_DROPIN"
SSHD_T_RC=1
fresh
setup_sshd_hardening >/dev/null
rc=$?
check "返回非 0（装机停下）" "$rc" 1
check "文件撤掉了" "$([[ -e "$SSHD_HARDENING_DROPIN" ]] && echo 还在 || echo 没有)" 没有
check "没有 reload" "$(count 'reload')" 0
check "判红一项，点名 sshd -t 和报错" "${#REDS[@]}" 1
has "红里有 sshd -t 不过、已撤掉、没重载和 sshd 自己的报错" "${REDS[*]}" "sshd -t 不过，已撤掉、没重载：.*Bad configuration option"
SSHD_T_RC=0

echo "== 2c.【故意造出的失败】sshd -t 过了但 reload 失败：判红（文件留着，下次 sshd 重启生效）"
rm -f -- "$SSHD_HARDENING_DROPIN"
SSHD_RELOAD_RC=1
fresh
setup_sshd_hardening >/dev/null
rc=$?
check "返回非 0" "$rc" 1
check "判红一项，点名 reload" "${#REDS[@]} $(grep -c 'reload ssh.service 没成' <<<"${REDS[*]}")" "1 1"
check "文件留着" "$([[ -e "$SSHD_HARDENING_DROPIN" ]] && echo 在 || echo 没有)" 在
SSHD_RELOAD_RC=0

echo "== 2d.【故意造出的失败】没有 sshd 命令、drop-in 目录不在：判红、不放文件"
rm -f -- "$SSHD_HARDENING_DROPIN"
SSHD_ABSENT=1
fresh
setup_sshd_hardening >/dev/null
rc=$?
check "没有 sshd 命令：返回非 0、判红、没放文件" "$rc ${#REDS[@]} $([[ -e "$SSHD_HARDENING_DROPIN" ]] && echo 有 || echo 没有)" "1 1 没有"
SSHD_ABSENT=0
saved=$SSHD_HARDENING_DROPIN
SSHD_HARDENING_DROPIN=$TMP/no-such-dir/50-x.conf
fresh
setup_sshd_hardening >/dev/null
rc=$?
check "目录不在：返回非 0、判红、一次 sshd 也没调" "$rc ${#REDS[@]} $(ncalls)" "1 1 0"
SSHD_HARDENING_DROPIN=$saved

echo "== 3. sshd 读回"
fresh
setup_sshd_hardening >/dev/null
fresh
readback_sshd_hardening >/dev/null
check "文件对、有效配置三项对：全绿" "${#REDS[@]} ${#PENDING[@]}" "0 0"
echo "== 3b.【故意造出的失败】有效配置里 maxstartups 还是老的（被别处的配置抢先盖掉）：判红，点名那一项"
SSHD_EFFECTIVE=$'logingracetime 20\nmaxauthtries 3\nmaxstartups 10:30:100'
fresh
readback_sshd_hardening >/dev/null
check "判红一项" "${#REDS[@]}" 1
has "点名 maxstartups 和读到的值" "${REDS[*]}" "maxstartups = 「10:30:100」，应为 30:30:120"
echo "== 3c.【故意造出的失败】有效配置里某一项根本没有：判红（不当成对了）"
SSHD_EFFECTIVE=$'logingracetime 20\nmaxstartups 30:30:120'
fresh
readback_sshd_hardening >/dev/null
has "点名 maxauthtries 没读到" "${REDS[*]}" "maxauthtries = 「没读到」"
echo "== 3d.【故意造出的失败】sshd -T 自己跑不成：判红"
SSHD_EFFECTIVE='no host keys'
SSHD_EFFECTIVE_RC=1
fresh
readback_sshd_hardening >/dev/null
has "判红：读不出有效配置" "${REDS[*]}" "sshd -T 读不出有效配置"
SSHD_EFFECTIVE_RC=0
SSHD_EFFECTIVE=$'logingracetime 20\nmaxauthtries 3\nmaxstartups 30:30:120'
echo "== 3e.【故意造出的失败】机器上的文件被手改过：判红"
printf '%s\n' 'LoginGraceTime 120' >"$SSHD_HARDENING_DROPIN"
fresh
readback_sshd_hardening >/dev/null
has "判红：和仓里不一样" "${REDS[*]}" "不在或和仓里 deploy/france/sshd-hardening.conf 不一样"

echo "== 4. fail2ban：没装 → 只记待配"
F2B_ABSENT=1
fresh
setup_fail2ban_sshd >/dev/null
rc=$?
check "返回 0、一条待配、没有红、没放文件" "$rc ${#PENDING[@]} ${#REDS[@]} $([[ -e "$FAIL2BAN_SSHD_JAIL" ]] && echo 有 || echo 没有)" "0 1 0 没有"
has "待配说的是没装 fail2ban" "${PENDING[*]}" "没装 fail2ban"
check "没调 fail2ban-client" "$(ncalls)" 0
fresh
readback_fail2ban_sshd >/dev/null
check "读回：没装是待配，不是红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
F2B_ABSENT=0

echo "== 4b. fail2ban：装了且在跑 → 放文件、-t、reload；再跑一遍不动"
fresh
setup_fail2ban_sshd >/dev/null
check "文件放对了" "$(cmp -s -- "$FAIL2BAN_SSHD_JAIL" "$F2B_CONF" && echo 一样 || echo 不一样)" 一样
check "调用顺序：先 -t 再 reload" "$(calls)" "fail2ban-client -t fail2ban-client reload"
check "没有红、没有待配" "${#REDS[@]} ${#PENDING[@]}" "0 0"
fresh
setup_fail2ban_sshd >/dev/null
check "第二遍：没有改动、没有调用" "${#CHANGES[@]} $(ncalls)" "0 0"

echo "== 4c.【故意造出的失败】fail2ban-client -t 不过：文件撤掉、不 reload、判红"
rm -f -- "$FAIL2BAN_SSHD_JAIL"
F2B_T_RC=1
fresh
setup_fail2ban_sshd >/dev/null
rc=$?
check "返回非 0、文件撤掉了、没有 reload、判红一项" \
  "$rc $([[ -e "$FAIL2BAN_SSHD_JAIL" ]] && echo 还在 || echo 没有) $(count reload) ${#REDS[@]}" "1 没有 0 1"
F2B_T_RC=0

echo "== 4d. fail2ban 装了但没在跑：文件放好、不 reload、待配"
rm -f -- "$FAIL2BAN_SSHD_JAIL"
F2B_ACTIVE=inactive
fresh
setup_fail2ban_sshd >/dev/null
rc=$?
check "返回 0、文件放了、没有 reload、一条待配、没有红" \
  "$rc $([[ -e "$FAIL2BAN_SSHD_JAIL" ]] && echo 有 || echo 没有) $(count reload) ${#PENDING[@]} ${#REDS[@]}" "0 有 0 1 0"
F2B_ACTIVE=active

echo "== 4e.【故意造出的失败】-t 过了但 reload 失败：判红"
rm -f -- "$FAIL2BAN_SSHD_JAIL"
F2B_RELOAD_RC=1
fresh
setup_fail2ban_sshd >/dev/null
rc=$?
check "返回非 0、判红一项" "$rc ${#REDS[@]}" "1 1"
F2B_RELOAD_RC=0

echo "== 5. fail2ban 读回"
rm -f -- "$FAIL2BAN_SSHD_JAIL"
fresh
setup_fail2ban_sshd >/dev/null
fresh
readback_fail2ban_sshd >/dev/null
check "文件对、四项对（True 也算 true）：全绿" "${#REDS[@]} ${#PENDING[@]}" "0 0"
echo "== 5b.【故意造出的失败】maxretry 还是 5（别的 jail 配置盖了或没 reload）：判红"
F2B_GET[maxretry]=5
fresh
readback_fail2ban_sshd >/dev/null
check "判红一项，点名 maxretry" "${#REDS[@]} $(grep -c 'maxretry = 「5」，应为 3' <<<"${REDS[*]}")" "1 1"
F2B_GET[maxretry]=3
echo "== 5c.【故意造出的失败】sshd jail 不在：判红"
F2B_STATUS_RC=1
fresh
readback_fail2ban_sshd >/dev/null
has "判红：没有在跑的 sshd jail" "${REDS[*]}" "没有在跑的 sshd jail"
F2B_STATUS_RC=0
echo "== 5d. fail2ban-client 答不出 bantime.increment：待配，不当成对了也不判红"
unset 'F2B_GET[bantime.increment]'
fresh
readback_fail2ban_sshd >/dev/null
check "一条待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
F2B_GET[bantime.increment]=True
echo "== 5e.【故意造出的失败】文件被手改过：判红"
printf '%s\n' '[sshd]' 'maxretry = 99' >"$FAIL2BAN_SSHD_JAIL"
fresh
readback_fail2ban_sshd >/dev/null
has "判红：和仓里不一样" "${REDS[*]}" "不在或和仓里 deploy/france/fail2ban-sshd.jail 不一样"

echo "== 6. 隧道网段不封（#1784）：两份 jail 都放过 10.99.0.0/24；香港读回查 ignoreip"
HK_F2B_CONF=$DEPLOY_DIR/hk/fail2ban-sshd.jail
for f in "$F2B_CONF" "$HK_F2B_CONF"; do
  has "${f#"$DEPLOY_DIR"/} 的 ignoreip 行含 10.99.0.0/24" "$(grep -E '^ignoreip = ' "$f")" "10.99.0.0/24"
done
check "香港 jail 的设置和法国那份一样" \
  "$(grep -vE '^[[:space:]]*(#|$)' "$HK_F2B_CONF" | tr -d '\r')" \
  "$(grep -vE '^[[:space:]]*(#|$)' "$F2B_CONF" | tr -d '\r')"
rm -f -- "$FAIL2BAN_SSHD_JAIL"
fresh
setup_fail2ban_sshd "$HK_F2B_CONF" >/dev/null
check "香港：放的是香港那份、先 -t 再 reload" \
  "$(cmp -s -- "$FAIL2BAN_SSHD_JAIL" "$HK_F2B_CONF" && echo 一样 || echo 不一样) $(calls)" "一样 fail2ban-client -t fail2ban-client reload"
F2B_GET[ignoreip]="127.0.0.1/8 ::1 10.99.0.0/24"
fresh
readback_fail2ban_sshd "$HK_F2B_CONF" 10.99.0.0/24 >/dev/null
check "香港读回：ignoreip 含隧道网段 → 全绿" "${#REDS[@]} ${#PENDING[@]}" "0 0"
echo "== 6b.【故意造出的失败】ignoreip 里没有隧道网段（手放的旧 sshd.local 盖了）：判红"
F2B_GET[ignoreip]="127.0.0.1/8 ::1"
fresh
readback_fail2ban_sshd "$HK_F2B_CONF" 10.99.0.0/24 >/dev/null
has "判红：ignoreip 里没有 10.99.0.0/24" "${REDS[*]}" "ignoreip 里没有 10.99.0.0/24"
echo "== 6c. ignoreip 读不出：待配，不当成对了"
unset 'F2B_GET[ignoreip]'
fresh
readback_fail2ban_sshd "$HK_F2B_CONF" 10.99.0.0/24 >/dev/null
check "一条待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "1 0"

echo "== 7. 会话用户的登录口子收口（#1785）：~/.ssh 挪走、钥匙放 /etc/ssh/authorized_keys/<用户>、Match User 段"
SESSION_USERS=(fleet-agent-carpool)
PILOT_USER=pilot
U=${SESSION_USERS[0]}
SSHD_SESSION_USER_DROPIN=$TMP/sshd_config.d/51-fleet-dao-session-user.conf
SESSION_SSH_KEYS_DIR=$TMP/etc-ssh-keys
SESSION_SSH_ALLOW_FILE=$TMP/pilot-authorized_keys
SESSION_QUARANTINE_ROOT=$TMP/quarantine
SESSION_USER_HOME_ROOT=$TMP/home
session_user_today() { echo 2026-10-11; }
ensure_dir() { mkdir -p -- "$1"; }
SSH_BEFORE=$'# founder\nssh-ed25519 AAAAfounder founder'
printf '%s\n' "$SSH_BEFORE" >"$SESSION_SSH_ALLOW_FILE"
put_dirty_home() {
  rm -rf -- "${SESSION_USER_HOME_ROOT:?}/$U"
  mkdir -p "$SESSION_USER_HOME_ROOT/$U/.ssh"
  echo 'Host x' >"$SESSION_USER_HOME_ROOT/$U/.ssh/config"
  echo 'PRIVATE' >"$SESSION_USER_HOME_ROOT/$U/.ssh/fleet_login"
  printf '%s\n' "$SSH_BEFORE" 'ssh-ed25519 AAAAstranger fleet-login-1773-france-carpool' >"$SESSION_USER_HOME_ROOT/$U/.ssh/authorized_keys"
}
echo "-- 7a. 首次装：多余文件和钥匙挪进隔离目录、钥匙文件照 pilot 写、drop-in 放好、sshd -t 后 reload"
put_dirty_home
fresh
setup_session_ssh >/dev/null
Q=$SESSION_QUARANTINE_ROOT/$U-ssh-2026-10-11/dot-ssh
check "家里的 .ssh 挪走了" "$([[ -e "$SESSION_USER_HOME_ROOT/$U/.ssh" ]] && echo 在 || echo 没有)" 没有
check "多出来的文件和钥匙在隔离目录里（没删）" \
  "$(find "$Q" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ' ') $(grep -c stranger "$Q/authorized_keys")" "authorized_keys config fleet_login  1"
has "记了 changed：挪走" "${CHANGES[*]}" "把 $U 的 ~/.ssh（.*）挪到"
check "钥匙文件内容就是 pilot 那份（多出来的那把不在）" "$(cat "$SESSION_SSH_KEYS_DIR/$U")" "$SSH_BEFORE"
has "drop-in 里有会话用户的 Match 段" "$(<"$SSHD_SESSION_USER_DROPIN")" "^Match User $U"
has "drop-in 里认钥匙的文件指到 /etc 下那份（%u）" "$(<"$SSHD_SESSION_USER_DROPIN")" "AuthorizedKeysFile $SESSION_SSH_KEYS_DIR/%u"
check "没有残留占位符" "$(grep -c '@@' "$SSHD_SESSION_USER_DROPIN" || true)" 0
check "调用顺序：先 sshd -t 再 reload" "$(calls)" "sshd -t systemctl reload ssh.service"
check "没有红、没有待配" "${#REDS[@]} ${#PENDING[@]}" "0 0"
echo "-- 7b. 再跑一遍什么都不动"
fresh
setup_session_ssh >/dev/null
check "没有改动记录、没有任何调用" "${#CHANGES[@]} $(ncalls)" "0 0"
echo "-- 7c.【故意造出的失败】会话又自己写了 ~/.ssh：这一遍再挪一次，放进 -2，不覆盖上一次"
put_dirty_home
fresh
setup_session_ssh >/dev/null
check "第二个隔离目录在、第一个没动" "$([[ -f "$SESSION_QUARANTINE_ROOT/$U-ssh-2026-10-11-2/dot-ssh/config" && -f "$Q/config" ]] && echo 都在 || echo 缺)" 都在
check "只记了挪走这一笔（钥匙文件和 drop-in 没变、没有 sshd 调用）" "${#CHANGES[@]} $(count 'sshd')" "1 0"
echo "-- 7d.【故意造出的失败】sshd -t 不过：drop-in 撤掉、不 reload、判红（钥匙文件已放好）"
rm -f -- "$SSHD_SESSION_USER_DROPIN"
SSHD_T_RC=1
fresh
setup_session_ssh >/dev/null
rc=$?
check "返回非 0、drop-in 撤掉了、没有 reload、判红一项" \
  "$rc $([[ -e "$SSHD_SESSION_USER_DROPIN" ]] && echo 还在 || echo 没有) $(count reload) ${#REDS[@]}" "1 没有 0 1"
has "红里有 sshd -t 不过、已撤掉、没重载" "${REDS[*]}" "sshd -t 不过，已撤掉、没重载"
SSHD_T_RC=0
echo "-- 7e.【故意造出的失败】pilot 那份读不到：不写钥匙文件、判红，drop-in 照装（会话用户登不进来，比留着家里那个口子强）"
rm -f -- "$SSHD_SESSION_USER_DROPIN"
rm -rf -- "${SESSION_SSH_KEYS_DIR:?}"
SESSION_SSH_ALLOW_FILE_SAVE=$SESSION_SSH_ALLOW_FILE
SESSION_SSH_ALLOW_FILE=$TMP/no-such-pilot-file
fresh
setup_session_ssh >/dev/null
check "钥匙文件没写、drop-in 放了、判红一项" \
  "$([[ -e "$SESSION_SSH_KEYS_DIR/$U" ]] && echo 有 || echo 没有) $([[ -e "$SSHD_SESSION_USER_DROPIN" ]] && echo 放了 || echo 没放) ${#REDS[@]}" "没有 放了 1"
has "红里点名 pilot 那份读不到" "${REDS[*]}" "读不到或是空的"
SESSION_SSH_ALLOW_FILE=$SESSION_SSH_ALLOW_FILE_SAVE
echo "-- 7f.【故意造出的失败】没有 sshd 命令：判红、不放文件"
rm -f -- "$SSHD_SESSION_USER_DROPIN"
SSHD_ABSENT=1
fresh
setup_session_ssh >/dev/null
rc=$?
check "返回非 0、判红一项、没放 drop-in" "$rc ${#REDS[@]} $([[ -e "$SSHD_SESSION_USER_DROPIN" ]] && echo 有 || echo 没有)" "1 1 没有"
SSHD_ABSENT=0

echo "-- 7g. 读回：drop-in 和仓里一样；sshd -T -C 里会话用户认 /etc 下那份、pilot 还是自己家里的"
fresh
setup_session_ssh >/dev/null
SSHD_AKF=([$U]="$SESSION_SSH_KEYS_DIR/%u" [pilot]=".ssh/authorized_keys .ssh/authorized_keys2")
fresh
readback_session_ssh_scope >/dev/null
check "全绿" "${#REDS[@]} ${#PENDING[@]}" "0 0"
echo "-- 7h.【故意造出的失败】Match 段没生效（有效配置里会话用户还认家里的）：判红"
SSHD_AKF=([$U]=".ssh/authorized_keys .ssh/authorized_keys2" [pilot]=".ssh/authorized_keys .ssh/authorized_keys2")
fresh
readback_session_ssh_scope >/dev/null
check "判红一项，点名会话用户" "${#REDS[@]} $(grep -c "$U 认钥匙的文件是「.ssh/authorized_keys" <<<"${REDS[*]}")" "1 1"
echo "-- 7i.【故意造出的失败】Match 段漏到了 pilot：判红"
SSHD_AKF=([$U]="$SESSION_SSH_KEYS_DIR/%u" [pilot]="$SESSION_SSH_KEYS_DIR/%u")
fresh
readback_session_ssh_scope >/dev/null
has "判红：pilot 也被指到了 /etc 下" "${REDS[*]}" "pilot 认钥匙的文件也成了"
echo "-- 7j.【故意造出的失败】drop-in 被手改、sshd -T -C 读不出：各判红"
SSHD_AKF=([$U]="$SESSION_SSH_KEYS_DIR/%u" [pilot]=".ssh/authorized_keys")
printf '%s\n' 'Match User root' >"$SSHD_SESSION_USER_DROPIN"
SSHD_EFFECTIVE_RC=1
fresh
readback_session_ssh_scope >/dev/null
has "判红：drop-in 和仓里不一样" "${REDS[*]}" "不在或和仓里 deploy/france/sshd-session-user.conf 不一样"
check "两个用户的 sshd -T -C 都读不出：再各一条红（共 3）" "${#REDS[@]}" 3
SSHD_EFFECTIVE_RC=0
if ((fail)); then
  echo "sshd-hardening：不通过"
  exit 1
fi
echo "sshd-hardening：通过"
