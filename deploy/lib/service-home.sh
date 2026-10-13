#!/usr/bin/env bash
# 服务用户的目录里 root 属主的文件（france.sh 的装机和读回用）。要先 source common.sh（ok、changed）。
# deploy/test/service-home.test.sh 真建目录、造 root 属主的文件走一遍。
#
# 为什么要修：fleet-cli-upgrade.service 等单元以 root 跑，往 fleet 的目录里写文件（/var/lib/fleet-dao/cli-upgrade/state.json），
# 写出来归 root。读回（readback_service_home）把这种文件判红，整套就不记「已装到哪一版」，后端 /healthz 一直报装机脚本落后。
# 这里在读回之前把它们改回所在目录的属主：只改所在目录不归 root 的（目录本身归 root 的不碰，留给读回报红）。

# 要查的目录：fleet 的家、状态和日志目录、pilot 的家、各会话用户的家（取 france.sh 的 PILOT_HOME、SESSION_USERS）
service_home_dirs() {
  local u
  printf '%s\n' /home/fleet /var/lib/fleet-dao /var/log/fleet-dao "$PILOT_HOME"
  for u in "${SESSION_USERS[@]}"; do printf '%s\n' "/home/$u"; done
}

# 把上面这些目录里 root 属主的文件改回所在目录的属主，改了几个记一条 changed
fix_service_home_owners() {
  local -a homes=()
  local d f dir owner n=0
  while IFS= read -r d; do
    [[ -d "$d" ]] && homes+=("$d")
  done < <(service_home_dirs)
  ((${#homes[@]})) || return 0
  while IFS= read -r -d '' f; do
    dir=$(dirname -- "$f")
    owner=$(stat -c '%u:%g' -- "$dir" 2>/dev/null) || continue
    [[ "${owner%%:*}" == 0 ]] && continue
    if chown -h -- "$owner" "$f" 2>/dev/null; then n=$((n + 1)); fi
  done < <(find "${homes[@]}" -user root -print0 2>/dev/null || true)
  if ((n > 0)); then
    changed "服务用户目录里 $n 个 root 属主的文件改回了所在目录的属主（root 身份的单元写进去的，如 cli-upgrade/state.json）"
  else
    ok "服务用户目录里没有要改属主的 root 文件"
  fi
}
