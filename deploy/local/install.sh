#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 本机档装机入口（#451）：在 fleet-local 里以 root 跑，两步——
#   1. 本机档自己的一步：WSL 的回环留在本机（#731，为什么见 fleet-wsl-loopback.sh 开头）。把那个脚本装成
#      /usr/local/sbin/fleet-wsl-loopback、装两个单元（开机补一次、之后每分钟补一次），现在就补一次，再读回规则和实际走哪；
#   2. FLEET_PROFILE=local bash deploy/france.sh "$@"（包这一层也省得每次记 FLEET_PROFILE 这个变量名，deploy/lib/profile.sh
#      讲了为什么是环境变量、不是配置文件里一项）。
# 第 1 步排在前面：france.sh 的读回（会话用户连不连得上 Temporal、库，会话用户开的口）要连回环，规则不在就全是红的。第 1 步
# 出了意外（命令没跑成、读不了仓里的文件）就照 france.sh 的规矩停下、给出结论，不往下装。
# 装什么、跳过什么见 deploy/local/desired-config.json 里每一项的「说明」，和 docs/ops.md「本机环境（fleet-local）」那节。
#   bash deploy/local/install.sh           装：缺的补上，已有的不动
#   bash deploy/local/install.sh --check   只读回和自检，不改任何东西
# 退出码和 france.sh 一样（0 全绿、1 有红、2 没红但有待配），两步取更坏的那个；第 1 步的结论在最后再打一遍。
# deploy/test/wsl-loopback.test.sh 拿替身 systemctl 在一次性的网络命名空间里把第 1 步的装和读回真跑一遍（source 本文件，
# main 不跑）。
LOCAL_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$LOCAL_DIR/../lib/common.sh"

CHECK_ONLY=0
WSL_LOOPBACK_SRC=$LOCAL_DIR/fleet-wsl-loopback.sh
WSL_LOOPBACK_BIN=/usr/local/sbin/fleet-wsl-loopback
WSL_LOOPBACK_UNIT_DIR=/etc/systemd/system
WSL_LOOPBACK_UNITS=(fleet-wsl-loopback.service fleet-wsl-loopback.timer)

# 仓里的一份文件读成字符串（打到标准输出）：读不了、是空的返回 1——不拿空串当内容装上去
wsl_loopback_read() { # 文件
  local text
  if ! text=$(cat -- "$1" 2>/dev/null) || [[ -z "$text" ]]; then return 1; fi
  printf '%s' "$text"
}

# fleet-wsl-loopback 打的每一行（「ok / changed / red / pending 说明」）记进这边的账；认不出的一行记没查成
wsl_loopback_report() { # 输出
  local line
  while IFS= read -r line; do
    case $line in
    "ok "*) ok "${line#ok }" ;;
    "changed "*) changed "${line#changed }" ;;
    "red "*) red "${line#red }" ;;
    "pending "*) pending "${line#pending }" ;;
    "") ;;
    *) pending "fleet-wsl-loopback 说了认不出的一行：${line:0:200}" ;;
    esac
  done <<<"$1"
}

# 装：脚本、两个单元照仓里的放上去（对了就不动），开机那个启用、每分钟那个起着，现在就补一次
setup_wsl_loopback() {
  local script text unit out rc=0 units_changed=0
  if ! script=$(wsl_loopback_read "$WSL_LOOPBACK_SRC"); then
    red "读不了仓里的 $WSL_LOOPBACK_SRC（或是空的）：回环规则没装"
    return 1
  fi
  put_file "$WSL_LOOPBACK_BIN" root:root 755 "$script"
  for unit in "${WSL_LOOPBACK_UNITS[@]}"; do
    if ! text=$(wsl_loopback_read "$LOCAL_DIR/$unit"); then
      red "读不了仓里的 $LOCAL_DIR/$unit（或是空的）：回环规则的单元没装"
      return 1
    fi
    put_file "$WSL_LOOPBACK_UNIT_DIR/$unit" root:root 644 "$text"
    if ((WROTE)); then units_changed=1; fi
  done
  if ((units_changed)); then systemctl daemon-reload; fi
  # 开机那个是 oneshot、跑完就退：只启用，不用 ensure_unit_running 等它进 active
  if [[ "$(systemctl is-enabled fleet-wsl-loopback.service 2>/dev/null)" != enabled ]]; then
    systemctl enable --quiet fleet-wsl-loopback.service
    changed "启用 fleet-wsl-loopback.service（WSL 每次起来都补上回环规则）"
  fi
  ensure_unit_running fleet-wsl-loopback.timer "$units_changed"
  out=$("$WSL_LOOPBACK_BIN" apply 2>&1) || rc=$?
  wsl_loopback_report "$out"
  if ((rc != 0)); then
    if [[ $'\n'"$out" != *$'\nred '* ]]; then red "$WSL_LOOPBACK_BIN apply 退出 $rc：$(head -1 <<<"$out")"; fi
    return 1
  fi
}

# 读回：装上去的就是仓里这份、开机补和每分钟补都挂着、上一次跑成了；规则和 127.0.0.1 上几个口实际走哪拿仓里这份脚本查
readback_wsl_loopback() {
  local script text unit result out rc=0 before=${#REDS[@]}
  if ! script=$(wsl_loopback_read "$WSL_LOOPBACK_SRC"); then
    red "读不了仓里的 $WSL_LOOPBACK_SRC（或是空的）：回环规则没查"
    return 0
  fi
  if [[ ! -f "$WSL_LOOPBACK_BIN" || -L "$WSL_LOOPBACK_BIN" ]] || ! cmp -s -- "$WSL_LOOPBACK_BIN" <(printf '%s\n' "$script"); then
    red "$WSL_LOOPBACK_BIN 和仓里的 $WSL_LOOPBACK_SRC 不一样（或没装）：重跑 bash deploy/local/install.sh"
  elif [[ "$(stat -c '%U:%G %a' -- "$WSL_LOOPBACK_BIN" 2>/dev/null)" != "root:root 755" ]]; then
    red "$WSL_LOOPBACK_BIN 不是 root:root 755（它以 root 跑，别人改得了就能借它拿 root）：重跑 bash deploy/local/install.sh"
  fi
  for unit in "${WSL_LOOPBACK_UNITS[@]}"; do
    if ! text=$(wsl_loopback_read "$LOCAL_DIR/$unit"); then
      red "读不了仓里的 $LOCAL_DIR/$unit（或是空的）：装上去的对不对没比"
      continue
    fi
    if ! cmp -s -- "$WSL_LOOPBACK_UNIT_DIR/$unit" <(printf '%s\n' "$text"); then
      red "$WSL_LOOPBACK_UNIT_DIR/$unit 和仓里的不一样（或没装）：重跑 bash deploy/local/install.sh"
    fi
  done
  if [[ "$(systemctl is-enabled fleet-wsl-loopback.service 2>/dev/null)" != enabled ]]; then
    red "fleet-wsl-loopback.service 没启用：WSL 重启后回环规则不会自己补上"
  fi
  if [[ "$(systemctl is-active fleet-wsl-loopback.timer 2>/dev/null)" != active ||
    "$(systemctl is-enabled fleet-wsl-loopback.timer 2>/dev/null)" != enabled ]]; then
    red "fleet-wsl-loopback.timer 没在跑（或没启用）：WSL 冲掉回环规则后不会自己补回来"
  fi
  result=$(systemctl show -p Result --value fleet-wsl-loopback.service 2>/dev/null) || result=""
  if [[ -n "$result" && "$result" != success ]]; then
    red "fleet-wsl-loopback.service 上一次没跑成（$result）：journalctl -u fleet-wsl-loopback 看原因"
  fi
  if ((${#REDS[@]} == before)); then
    ok "$WSL_LOOPBACK_BIN 和两个单元就是仓里这份；开机补（service 启用）、每分钟补（timer 在跑）都挂着，上一次跑成了"
  fi
  out=$(bash "$WSL_LOOPBACK_SRC" check 2>&1) || rc=$?
  wsl_loopback_report "$out"
  case $rc in
  0 | 1 | 2) ;;
  *) red "$WSL_LOOPBACK_SRC check 没跑成（退出码 $rc）：$(head -1 <<<"$out")" ;;
  esac
}

# 两步的退出码合起来：有红 1 > 认不出的退出码（照原样） > 待配 2 > 全绿 0
combine_rc() { # 第 1 步 france.sh
  local a=$1 b=$2
  if ((a == 1 || b == 1)); then
    echo 1
  elif ((a != 0 && a != 2)); then
    echo "$a"
  elif ((b != 0 && b != 2)); then
    echo "$b"
  elif ((a == 2 || b == 2)); then
    echo 2
  else
    echo 0
  fi
}

main() {
  local frc=0 lrc=0
  set -Eeuo pipefail
  case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  "") ;;
  *)
    echo "用法：bash $0 [--check]" >&2
    exit 64
    ;;
  esac
  if ((EUID != 0)); then
    echo "要 root：sudo bash $0" >&2
    exit 64
  fi
  # 第 1 步出了意外照 france.sh 的规矩：给出结论再停（common.sh 的 on_error）
  trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
  step "本机档：WSL 的回环留在本机（#731；规则不在，下面 france.sh 读回里连回环的几项都会红）"
  if ((CHECK_ONLY == 0)); then setup_wsl_loopback; fi
  readback_wsl_loopback
  trap - ERR
  env FLEET_PROFILE=local bash "$LOCAL_DIR/../france.sh" "$@" || frc=$?
  printf '\n== 本机档自己那一步（WSL 的回环留在本机）的结论\n'
  if ((${#CHANGES[@]})); then
    printf '本次改动 %d 处：\n' "${#CHANGES[@]}"
    printf '  - %s\n' "${CHANGES[@]}"
  fi
  if ((${#REDS[@]})); then
    lrc=1
    printf '红 %d 项：\n' "${#REDS[@]}"
    printf '  - %s\n' "${REDS[@]}"
  elif ((${#PENDING[@]})); then
    lrc=2
    printf '待配 / 没查成 %d 项：\n' "${#PENDING[@]}"
    printf '  - %s\n' "${PENDING[@]}"
  else
    echo '全绿'
  fi
  exit "$(combine_rc "$lrc" "$frc")"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
