#!/usr/bin/env bash
# 香港 Ubuntu nginx 的请求体目录合同：固定路径、实际 www-data worker、0700。
# 不执行 nginx -t/-T（它们会创建或改属主临时目录），不写探针、不递归，不重载服务。
# 仅定义函数；日志由 common.sh 的 red/ok/changed 提供。

nginx_body_dir() { printf '/var/lib/nginx/body'; }

nginx_body_worker() {
  local uid processes line count=0
  if ! uid=$(id -u www-data 2>/dev/null) || [[ ! "$uid" =~ ^[0-9]+$ || "$uid" == 0 ]]; then
    red "nginx 请求体目录没查成：www-data 身份读不到"
    return 1
  fi
  if ! processes=$(ps -C nginx -o euid=,args= 2>/dev/null); then
    red "nginx 请求体目录没查成：实际 worker 进程读不到"
    return 1
  fi
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*([0-9]+)[[:space:]]+nginx:[[:space:]]worker[[:space:]]process([[:space:]].*)?$ ]]; then
      if [[ "${BASH_REMATCH[1]}" != "$uid" ]]; then
        red "nginx 请求体目录不适用：实际 worker 不是 www-data"
        return 1
      fi
      count=$((count + 1))
    fi
  done <<<"$processes"
  if ((count == 0)); then
    red "nginx 请求体目录没查成：没有识别到实际 www-data worker"
    return 1
  fi
  NGINX_BODY_UID=$uid
}

nginx_body_parents() {
  local dir=$1 parent uid mode
  parent=${dir%/*}
  while :; do
    if [[ -L "$parent" || ! -d "$parent" ]] ||
      ! read -r uid mode < <(stat -c '%u %a' -- "$parent" 2>/dev/null) ||
      [[ "$uid" != 0 || ! "$mode" =~ ^[0-7]{3,4}$ ]] || ((8#$mode & 8#022)); then
      red "nginx 请求体目录不安全：父目录 $parent 必须为非链接、root 属主且组和其他人不可写"
      return 1
    fi
    [[ "$parent" == / ]] && break
    parent=${parent%/*}
    [[ -n "$parent" ]] || parent=/
  done
}

nginx_body_metadata() {
  local dir=$1
  if [[ -L "$dir" || ! -d "$dir" ]] ||
    ! read -r NGINX_BODY_OWNER NGINX_BODY_GROUP NGINX_BODY_MODE NGINX_BODY_ID < <(stat -c '%u %g %a %d:%i' -- "$dir" 2>/dev/null) ||
    [[ ! "$NGINX_BODY_OWNER $NGINX_BODY_GROUP $NGINX_BODY_MODE $NGINX_BODY_ID" =~ ^[0-9]+\ [0-9]+\ [0-7]{3,4}\ [0-9]+:[0-9]+$ ]]; then
    red "nginx 请求体目录 $dir 不存在、不是普通目录、为链接或 metadata 读不到"
    return 1
  fi
}

nginx_body_access() {
  local dir=$1
  if [[ "$NGINX_BODY_OWNER" != "$NGINX_BODY_UID" || "$NGINX_BODY_MODE" != 700 ]]; then
    red "nginx 请求体目录 $dir 应归 www-data 且权限为 700（实际 uid $NGINX_BODY_OWNER，权限 $NGINX_BODY_MODE）"
    return 1
  fi
  if ! runuser -u www-data -- test -w "$dir" || ! runuser -u www-data -- test -x "$dir"; then
    red "nginx 请求体目录 $dir 的 www-data 可写/可进入检查失败，未创建探针"
    return 1
  fi
  ok "nginx 请求体目录 $dir：实际 www-data worker，700，可写且可进入"
}

readback_nginx_body() {
  local dir
  dir=$(nginx_body_dir)
  nginx_body_worker && nginx_body_parents "$dir" && nginx_body_metadata "$dir" && nginx_body_access "$dir"
}

ensure_nginx_body() {
  local dir before_group before_id touched=0
  dir=$(nginx_body_dir)
  nginx_body_worker || return 1
  nginx_body_parents "$dir" || return 1
  if [[ ! -e "$dir" && ! -L "$dir" ]]; then
    if ! mkdir -m 700 -- "$dir"; then
      red "nginx 请求体目录 $dir 创建失败"
      return 1
    fi
    touched=1
  fi
  nginx_body_metadata "$dir" || return 1
  before_group=$NGINX_BODY_GROUP
  before_id=$NGINX_BODY_ID
  if [[ "$NGINX_BODY_OWNER" != "$NGINX_BODY_UID" ]]; then
    if ! chown --no-dereference "$NGINX_BODY_UID" -- "$dir"; then
      red "nginx 请求体目录 $dir 的属主修复失败"
      return 1
    fi
    touched=1
  fi
  if [[ "$NGINX_BODY_MODE" != 700 ]]; then
    if ! chmod 700 -- "$dir"; then
      red "nginx 请求体目录 $dir 的权限修复失败"
      return 1
    fi
    touched=1
  fi
  nginx_body_parents "$dir" && nginx_body_metadata "$dir" || return 1
  if [[ "$NGINX_BODY_GROUP" != "$before_group" || "$NGINX_BODY_ID" != "$before_id" ]]; then
    red "nginx 请求体目录 $dir 的组或 inode 变了，未证明安全修复"
    return 1
  fi
  nginx_body_access "$dir" || return 1
  if ((touched)); then changed "只修复 nginx 请求体目录 $dir 的属主/700 权限（保留组、inode 和内容）"; fi
}
