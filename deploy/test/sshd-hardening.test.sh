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
#   5. fail2ban 读回：四项对 → 全绿；【故意造出的失败】值不对、jail 不在 → 判红；fail2ban-client 答不出 → 待配（不当成对了）
# 用法：bash deploy/test/sshd-hardening.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/human-tier.sh
source "$HERE/../lib/human-tier.sh"

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
check "fail2ban jail：只有 [sshd] 一段、五项设置" "$f2b" $'[sshd]\nenabled = true\nmaxretry = 3\nfindtime = 10m\nbantime = 1h\nbantime.increment = true'

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

if ((fail)); then
  echo "sshd-hardening：不通过"
  exit 1
fi
echo "sshd-hardening：通过"
