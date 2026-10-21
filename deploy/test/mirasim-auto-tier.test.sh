#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034,SC2317,SC2329 # 桩函数和被 eval 进来的 france.sh 函数用到的变量，shellcheck 看不出
# Mirasim 常驻单元归「自动档」（#1274）：发版后自动跑的 france.sh --auto-tier 也装它、读回核对。
# 以前它只在整套装机时装，所以 #1277 往单元里加的 MIRASIM_NO_AGENT_EGRESS=1 合进主线、发了版，法国上装着的还是老单元。
# 这里不需要 root、systemd：把 france.sh 里的 setup_auto_tier / setup_mirasim_session / readback_auto_tier 原文取出来，
# 底下的 put_file、systemctl、ensure_unit_running、mirasim_server_installed 换成桩，只看流程和判据：
#   1. setup_auto_tier 会调 setup_mirasim_session（顺序在自动发布单元之后）；readback_auto_tier 会读回这个单元
#   2. 服务端本体不在：记待配、不写单元文件、不重启，没有红（自动发布据此把退出码 2 当装上了）
#   3. 本体在：第一次装 → 写文件、daemon-reload、ensure_unit_running 带重启=1；
#      再跑一遍内容没变 → 不写、不 daemon-reload、重启=0（正在跑的 Mirasim 会话不断）；
#      模板改了 → 写、重启=1
#   4. 读回 check_mirasim_session_unit_file：装着的文件和仓里一样判绿；缺 MIRASIM_NO_AGENT_EGRESS=1 判红
#      【故意造出的失败】；模板自己缺这一行（装的和模板一致）也判红；文件不存在判红；本体不在什么都不判
# 用法：bash deploy/test/mirasim-auto-tier.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/mirasim.sh
source "$HERE/../lib/mirasim.sh"

FRANCE_SH=$HERE/../france.sh
# 取函数原文（到行首的 } 为止），去掉 CR（Windows 检出可能带）
fn_text() { tr -d '\r' <"$FRANCE_SH" | sed -n "/^$1() {/,/^}/p"; }
for f in setup_auto_tier setup_mirasim_session readback_auto_tier readback_mirasim_session_unit install_mirasim_stream_guard mirasim_retired retire_mirasim_units; do
  if [[ -z "$(fn_text "$f")" ]]; then
    echo "mirasim-auto-tier：没跑成：在 deploy/france.sh 里没取到 $f"
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
fresh() { CHANGES=() REDS=() PENDING=() CALLS=(); }

TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

# ── 桩：只记调用，不碰机器 ──
CALLS=()
SERVER_INSTALLED=0
id() { return 0; }
systemctl() { # is-active 一律答 active（读回里自动发布 timer 那一项不是这里要测的）；别的只记
  if [[ "$1" == is-enabled ]]; then
    echo enabled
    return 0
  fi
  if [[ "$1" == is-active ]]; then
    echo active
    return 0
  fi
  CALLS+=("systemctl $*")
}
ensure_unit_running() { CALLS+=("ensure_unit_running $1 $2"); }
mirasim_server_installed() { ((SERVER_INSTALLED)); }
# 和 common.sh 的 put_file 同一个判法（内容一样不动、WROTE 记有没有写），只是不 chown/chmod（不要 root）
put_file() { # 目标 属主:组 权限 内容
  local dest=$1 content=$4
  WROTE=0
  if [[ -f "$dest" ]] && cmp -s -- "$dest" <(printf '%s\n' "$content"); then return 0; fi
  printf '%s\n' "$content" >"$dest"
  changed "写 $dest"
}
# 自动档里的另外几步：只记顺序。liveness 是 setup_mirasim_session 的最后一步，这里不测它装没装上。
setup_mirasim_liveness() { CALLS+=(setup_mirasim_liveness); }
# 真函数会写 /usr/local/lib（要 root）。这里只记调用顺序，并清掉 WROTE，免得守卫的「变了」被当成单元变了。
install_mirasim_stream_guard() { CALLS+=(install_mirasim_stream_guard); WROTE=0; }
setup_slice() { CALLS+=(setup_slice); }
setup_user_slice_cap() { CALLS+=(setup_user_slice_cap); }
readback_user_slice_cap() { CALLS+=(readback_user_slice_cap); }
retire_old_units() { CALLS+=(retire_old_units); }
setup_auto_release() { CALLS+=(setup_auto_release); }
setup_release_request_scripts() { CALLS+=(setup_release_request_scripts); }
setup_footprint() { CALLS+=(setup_footprint); }
readback_footprint() { CALLS+=(readback_footprint); }
readback_slice() { CALLS+=(readback_slice); }
readback_retired_units() { CALLS+=(readback_retired_units); }

# 取进来的 france.sh 原文用到的变量
SESSION_USERS=(fleet-mirasim-fake)
MIRASIM_SESSION_PORT=54321
MIRASIM_RETIRED_FILE=$TMP/mirasim-retired
MIRASIM_LIVENESS_UNITS=(fleet-mirasim-liveness.service fleet-mirasim-liveness.timer)
MIRASIM_SESSION_UNIT_FILE=$TMP/fleet-mirasim-session.service
AUTO_RELEASE_FILES=()
AUTO_RELEASE_UNITS=()
AUTO_RELEASE_LIB=$TMP/auto-release-lib
DEPLOY_DIR=$TMP/deploy
mkdir -p "$DEPLOY_DIR/france"
cp -- "$HERE/../france/fleet-mirasim-session.service" "$DEPLOY_DIR/france/"
TPL=$DEPLOY_DIR/france/fleet-mirasim-session.service

eval "$(fn_text setup_auto_tier)"
eval "$(fn_text setup_mirasim_session)"
eval "$(fn_text readback_auto_tier)"
eval "$(fn_text readback_mirasim_session_unit)"
eval "$(fn_text mirasim_retired)"
eval "$(fn_text retire_mirasim_units)"

echo "== 1. 自动档入口会装 Mirasim 常驻单元（在自动发布单元之后），读回也读它"
fresh
SERVER_INSTALLED=0
setup_auto_tier >/dev/null
check "setup_auto_tier 先走完自动发布那几步" "${CALLS[*]}" \
  "setup_slice setup_user_slice_cap retire_old_units setup_auto_release setup_release_request_scripts setup_footprint"
has "setup_auto_tier 走到了 Mirasim 常驻单元这一步（本体不在，所以只记待配）" "${PENDING[*]}" "还没有 Mirasim 服务端本体"
fresh
readback_auto_tier >/dev/null 2>&1
has "readback_auto_tier 读回了 slice、老单元" "${CALLS[*]}" "readback_slice readback_user_slice_cap readback_retired_units"
has "readback_auto_tier 读回 Mirasim 常驻单元（本体不在：待配，不是红）" "${PENDING[*]}" "还没有 Mirasim 服务端本体"
check "读回没有红" "${#REDS[@]}" "0"

echo "== 2. 服务端本体不在：待配，不写单元、不重启，没有红"
fresh
SERVER_INSTALLED=0
rm -f -- "$MIRASIM_SESSION_UNIT_FILE"
setup_mirasim_session >/dev/null
check "记一笔待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
check "没写单元文件" "$([[ -e "$MIRASIM_SESSION_UNIT_FILE" ]] && echo 有 || echo 没有)" "没有"
check "没有 daemon-reload，没有 ensure_unit_running" "$(printf '%s\n' "${CALLS[@]}" | grep -cE 'daemon-reload|ensure_unit_running' || true)" "0"
check "本体不在不装流守卫（--require 的文件还不该被单元指上）" "$(printf '%s\n' "${CALLS[@]}" | grep -c install_mirasim_stream_guard || true)" "0"

echo "== 2b. 有退役标记：自动档停掉并取消自启，不写单元、不装健康检查"
touch -- "$MIRASIM_RETIRED_FILE"
fresh
SERVER_INSTALLED=1
rm -f -- "$MIRASIM_SESSION_UNIT_FILE"
setup_mirasim_session >/dev/null
check "有标记时不写 Mirasim 单元" "$([[ -e "$MIRASIM_SESSION_UNIT_FILE" ]] && echo 有 || echo 没有)" "没有"
check "有标记时不拉起 Mirasim 单元" "$(printf '%s\n' "${CALLS[@]}" | grep -cE 'ensure_unit_running|daemon-reload' || true)" "0"
check "有标记时停掉并取消两份 Mirasim 单元自启" \
  "$(printf '%s\n' "${CALLS[@]}" | grep 'systemctl disable --now')" \
  $'systemctl disable --now fleet-mirasim-session.service\nsystemctl disable --now fleet-mirasim-liveness.timer'
check "有标记时不记待配或红" "${#PENDING[@]} ${#REDS[@]}" "0 0"
fresh
OUT=$(readback_auto_tier 2>&1)
has "自动档读回对退役 Mirasim 写已退役、不查" "$OUT" "Mirasim 已退役，不查"
rm -f -- "$MIRASIM_RETIRED_FILE"

echo "== 3. 服务端本体在：首次装 → 写、重启；内容没变 → 不动、不重启；模板变了 → 重启"
SERVER_INSTALLED=1
fresh
setup_mirasim_session >/dev/null
check "首次：写了文件" "$([[ -f "$MIRASIM_SESSION_UNIT_FILE" ]] && echo 有 || echo 没有)" "有"
has "首次：装的文件带 MIRASIM_NO_AGENT_EGRESS=1" "$(<"$MIRASIM_SESSION_UNIT_FILE")" '^Environment=MIRASIM_NO_AGENT_EGRESS=1$'
has "首次：daemon-reload 了" "${CALLS[*]}" "systemctl daemon-reload"
has "首次：ensure_unit_running 带重启=1" "${CALLS[*]}" "ensure_unit_running fleet-mirasim-session.service 1"
has "首次：先装流守卫再重启（--require 的文件得先在）" "${CALLS[*]}" "install_mirasim_stream_guard.*ensure_unit_running fleet-mirasim-session.service 1"
has "守卫脚本的安装路径钉在 france.sh" "$(<"$FRANCE_SH")" '^MIRASIM_STREAM_GUARD=/usr/local/lib/fleet-dao/mirasim-stream-guard\.cjs$'
has "安装函数从仓里把守卫写出去" "$(fn_text install_mirasim_stream_guard)" 'DEPLOY_DIR/lib/mirasim-stream-guard\.cjs'
check "首次：没有红、没有待配" "${#REDS[@]} ${#PENDING[@]}" "0 0"

fresh
setup_mirasim_session >/dev/null
check "第二遍：不写文件（没有改动记录）" "${#CHANGES[@]}" "0"
check "第二遍：不 daemon-reload" "$(printf '%s\n' "${CALLS[@]}" | grep -c 'daemon-reload' || true)" "0"
has "第二遍：ensure_unit_running 带重启=0（正在跑的 Mirasim 会话不断）" "${CALLS[*]}" "ensure_unit_running fleet-mirasim-session.service 0"
check "第二遍：不带重启=1" "$(printf '%s\n' "${CALLS[@]}" | grep -c 'service 1' || true)" "0"

printf '%s\n' '# 模板改了一处' >>"$TPL"
fresh
setup_mirasim_session >/dev/null
has "模板变了：写了文件" "${CHANGES[*]}" "写 $MIRASIM_SESSION_UNIT_FILE"
has "模板变了：daemon-reload 并重启=1" "${CALLS[*]}" "systemctl daemon-reload.*ensure_unit_running fleet-mirasim-session.service 1"
cp -- "$HERE/../france/fleet-mirasim-session.service" "$TPL"

echo "== 4. 读回单元文件内容"
SERVER_INSTALLED=1
fresh
setup_mirasim_session >/dev/null
fresh
check_mirasim_session_unit_file fleet-mirasim-fake "$MIRASIM_SESSION_UNIT_FILE" "$TPL" 54321 >/dev/null
check "装着的和仓里渲染出来的一样：判绿" "${#REDS[@]} ${#PENDING[@]}" "0 0"

echo "== 4b.【故意造出的失败】装着的是 09-29 的老单元（缺 MIRASIM_NO_AGENT_EGRESS=1）：判红，点名缺的那一行"
grep -vxF 'Environment=MIRASIM_NO_AGENT_EGRESS=1' "$MIRASIM_SESSION_UNIT_FILE" >"$TMP/old.service"
fresh
check_mirasim_session_unit_file fleet-mirasim-fake "$TMP/old.service" "$TPL" 54321 >/dev/null
check "判红一项" "${#REDS[@]}" "1"
has "红里点名缺 MIRASIM_NO_AGENT_EGRESS=1" "${REDS[*]}" "缺 Environment=MIRASIM_NO_AGENT_EGRESS=1"

echo "== 4c.【故意造出的失败】仓里模板自己缺这一行、装的和模板一致：也判红（不能只比「装的和仓里一样」）"
grep -vxF 'Environment=MIRASIM_NO_AGENT_EGRESS=1' "$TPL" >"$TMP/tpl-bad.service"
render "$TMP/tpl-bad.service" SESSION_USER=fleet-mirasim-fake MIRASIM_SESSION_PORT=54321
printf '%s\n' "$RENDERED" >"$TMP/installed-bad.service"
fresh
check_mirasim_session_unit_file fleet-mirasim-fake "$TMP/installed-bad.service" "$TMP/tpl-bad.service" 54321 >/dev/null
has "判红、点名缺的那一行" "${REDS[*]}" "缺 Environment=MIRASIM_NO_AGENT_EGRESS=1"

echo "== 4d.【故意造出的失败】两个开关都在，但整份和模板不一样（比如手改过）：判红"
{ cat -- "$MIRASIM_SESSION_UNIT_FILE"; echo 'Environment=FOO=bar'; } >"$TMP/edited.service"
fresh
check_mirasim_session_unit_file fleet-mirasim-fake "$TMP/edited.service" "$TPL" 54321 >/dev/null
has "判红：和仓里渲染出来的不一样" "${REDS[*]}" "渲染出来的不一样"

echo "== 4e.【故意造出的失败】本体已装但单元文件不存在：判红"
fresh
check_mirasim_session_unit_file fleet-mirasim-fake "$TMP/no-such.service" "$TPL" 54321 >/dev/null
has "判红：文件不存在" "${REDS[*]}" "不存在"

echo "== 4f. 本体不在：这一层什么都不判（待配由 check_mirasim_session_unit 记）"
SERVER_INSTALLED=0
fresh
check_mirasim_session_unit_file fleet-mirasim-fake "$TMP/no-such.service" "$TPL" 54321 >/dev/null
check "没有红、没有待配" "${#REDS[@]} ${#PENDING[@]}" "0 0"

echo "== 5. 刚重启、node 还没 listen（连接被拒）时 health 读回会等一会儿；一直被拒到次数用完才判红"
SERVER_INSTALLED=1
MIRASIM_HEALTH_TRIES=3
CURL_REFUSE=2 # 前几次答「连接被拒」（curl 退出 7）
echo 0 >"$TMP/curl-n"
curl() {
  local n
  n=$(<"$TMP/curl-n")
  echo $((n + 1)) >"$TMP/curl-n"
  if ((n < CURL_REFUSE)); then return 7; fi
  echo '{"ok":true}'
}
fresh
check_mirasim_session_unit fleet-mirasim-fake fleet-mirasim-session.service 54321 >/dev/null
check "被拒两次、第三次回 ok:true：判绿" "${#REDS[@]} ${#PENDING[@]}" "0 0"
CURL_REFUSE=99
echo 0 >"$TMP/curl-n"
fresh
check_mirasim_session_unit fleet-mirasim-fake fleet-mirasim-session.service 54321 >/dev/null
check "【故意造出的失败】一直被拒：试满 3 次后判红" "${#REDS[@]} $(<"$TMP/curl-n")" "1 3"
unset -f curl

echo "== 6. /api/health 超时：再试几次；自动档试满记待配，整套读回试满仍判红"
has "探活不走代理" "$(declare -f check_mirasim_session_unit)" "--noproxy '\\*'"
SERVER_INSTALLED=1
MIRASIM_HEALTH_TIMEOUT_TRIES=3
setup_mirasim_session >/dev/null
echo 0 >"$TMP/curl-n"
curl() {
  local n
  n=$(<"$TMP/curl-n")
  echo $((n + 1)) >"$TMP/curl-n"
  if ((n < 2)); then
    echo 'curl: (28) Operation timed out' >&2
    return 28
  fi
  echo '{"ok":true}'
}
fresh
check_mirasim_session_unit fleet-mirasim-fake fleet-mirasim-session.service 54321 >/dev/null
check "前两次超时、第三次回 ok：判绿" "${#REDS[@]} ${#PENDING[@]} $(<"$TMP/curl-n")" "0 0 3"

echo 0 >"$TMP/curl-n"
curl() {
  local n
  n=$(<"$TMP/curl-n")
  echo $((n + 1)) >"$TMP/curl-n"
  echo 'curl: (28) Operation timed out' >&2
  return 28
}
fresh
readback_mirasim_session_unit >/dev/null
check "自动档试满 3 次仍超时：待配、没有红" "${#REDS[@]} ${#PENDING[@]} $(<"$TMP/curl-n")" "0 1 3"
has "待配写明 curl 退出 28" "${PENDING[*]}" "curl 退出 28"
fresh
echo 0 >"$TMP/curl-n"
check_mirasim_session_unit fleet-mirasim-fake fleet-mirasim-session.service 54321 >/dev/null
check "【故意造出的失败】整套读回不传 pending：试满仍判红" "${#REDS[@]} ${#PENDING[@]}" "1 0"
unset -f curl

if ((fail)); then
  echo "mirasim-auto-tier：不通过"
  exit 1
fi
echo "mirasim-auto-tier：通过"
