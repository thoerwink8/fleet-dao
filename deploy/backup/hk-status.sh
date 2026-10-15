#!/usr/bin/env bash
# shellcheck shell=bash
# 香港状态文件。备份新鲜度、备份复制、法国失联探活都写这一份；谁先合谁定格式，后合的跟着这份。
# 路径默认 /var/lib/fleet-hk/status.json（目录 root:root 755，文件 root:root 644，谁都能读、只有 root 能写）。
# 锁是旁边的 status.json.lock，flock 包住读改写。
#
# 文件是 UTF-8 文本。第一行固定 v=1，后面每个检查一段，段与段之间一个空行：
#
#   v=1
#
#   check=<id>
#   ok=<0|1>
#   at=<YYYY-MM-DDTHH:MM:SS+08:00>
#   summary=<一行说明>
#
# id 只许小写字母开头，后面是小写字母、数字、点、下划线、减号，最长 64。
# ok=1 没事，ok=0 要看。at 是这一次写入的北京时间。summary 不换行、不带密钥。
# 谁写谁只替换自己的 check= 段（按段的第一行认），别的段原样留着。写回时分隔收成一个空行。
# 文件没有、是空的：写成只含自己这一段。第一行不是 v=1、或是符号链接：先改名为
# status.json.bad-<时刻>，再写新文件，不把坏内容混进来，也不跟着符号链接写到别处。
# 建议的检查名：backup.snapshot（最新快照是否超过 26 小时）、backup.copy（每天的复制成没成）、
# france.reach（法国失联探活，那张单自己用，这里不写它）。

hk_status_oneline() { # 文本 → 一行，最长 400 字符
  local s=$1
  s=${s//$'\r'/}
  s=${s//$'\n'/ }
  if ((${#s} > 400)); then s=${s:0:400}; fi
  printf '%s' "$s"
}

hk_status_block() { # id ok at summary（summary 已经收成一行）
  printf 'check=%s\nok=%s\nat=%s\nsummary=%s' "$1" "$2" "$3" "$4"
}

# 参数合法返回 0；不合法把原因打到 stderr、返回 1。summary 收成一行后从 stdout 没有，调用方自己再收。
hk_status_args_ok() { # id ok at summary
  local id=$1 ok=$2 at=$3 summary=$4
  if [[ ! "$id" =~ ^[a-z][a-z0-9._-]{0,63}$ ]]; then
    echo "检查名不合法（$id）" >&2
    return 1
  fi
  if [[ "$ok" != 0 && "$ok" != 1 ]]; then
    echo "ok 只许 0 或 1，收到「$ok」" >&2
    return 1
  fi
  if [[ ! "$at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\+08:00$ ]]; then
    echo "时间格式不对（$at）" >&2
    return 1
  fi
  if [[ -z "$(hk_status_oneline "$summary")" ]]; then
    echo "说明是空的" >&2
    return 1
  fi
}

# 把一段并进数组：是自己的检查就换成新的四行，否则原样。自己的段出现过，_hk_status_replaced=1。
hk_status_consider() { # 数组名 id ok at summary 段
  local -n _arr=$1
  local id=$2 ok=$3 at=$4 summary=$5 sec=$6
  local head=${sec%%$'\n'*}
  if [[ "$head" == "check=$id" ]]; then
    _hk_status_replaced=1
    _arr+=("$(hk_status_block "$id" "$ok" "$at" "$summary")")
  else
    _arr+=("$sec")
  fi
}

# 从标准输入读旧文件，stdout 打新文件全文（以换行结束）。
# 返回 0 成；1 参数不合法；2 旧文件不是 v=1（调用方把旧的挪走，再写一份只含自己的）。
hk_status_merge() { # id ok at summary
  local id=$1 ok=$2 at=$3 summary=$4
  local line first=1 sec="" s body
  local -a out=()
  summary=$(hk_status_oneline "$summary")
  hk_status_args_ok "$id" "$ok" "$at" "$summary" || return 1
  _hk_status_replaced=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    if ((first)); then
      first=0
      if [[ "$line" != "v=1" ]]; then
        echo "状态文件没有 v=1" >&2
        return 2
      fi
      continue
    fi
    if [[ -z "$line" ]]; then
      if [[ -n "$sec" ]]; then
        hk_status_consider out "$id" "$ok" "$at" "$summary" "$sec"
        sec=""
      fi
    else
      sec+="${sec:+$'\n'}$line"
    fi
  done
  if [[ -n "$sec" ]]; then
    hk_status_consider out "$id" "$ok" "$at" "$summary" "$sec"
  fi
  if ((_hk_status_replaced == 0)); then
    out+=("$(hk_status_block "$id" "$ok" "$at" "$summary")")
  fi
  body="v=1"
  if ((${#out[@]})); then
    for s in "${out[@]}"; do
      body+=$'\n\n'"$s"
    done
  fi
  printf '%s\n' "$body"
}

hk_status_now_at() { # 北京时间。HK_NOW_EPOCH 设了就用它（测试），没设用现在
  if [[ -n "${HK_NOW_EPOCH:-}" ]]; then
    if [[ ! "$HK_NOW_EPOCH" =~ ^[0-9]+$ ]]; then
      echo "现在的时刻认不出（$HK_NOW_EPOCH）" >&2
      return 1
    fi
    TZ=Asia/Shanghai date -d "@$HK_NOW_EPOCH" +%Y-%m-%dT%H:%M:%S+08:00
  else
    TZ=Asia/Shanghai date +%Y-%m-%dT%H:%M:%S+08:00
  fi
}

# 拼一份只有自己这一段的新文件（不带结尾换行；写盘时再补一个）。
hk_status_fresh() { # id ok at summary
  printf 'v=1\n\n%s' "$(hk_status_block "$1" "$2" "$3" "$4")"
}

# 只改自己那一段。文件名默认 HK_STATUS_FILE，没设就是 /var/lib/fleet-hk/status.json。
hk_status_write() { # id ok summary
  local id=$1 ok=$2 summary=$3
  local file=${HK_STATUS_FILE:-/var/lib/fleet-hk/status.json}
  local dir lock at
  dir=$(dirname -- "$file")
  lock=$file.lock
  if [[ -L "$dir" || -L "$file" || -L "$lock" ]]; then
    echo "状态文件或它的目录、锁是符号链接，不写（$file）" >&2
    return 1
  fi
  summary=$(hk_status_oneline "$summary")
  at=$(hk_status_now_at) || return 1
  hk_status_args_ok "$id" "$ok" "$at" "$summary" || return 1
  if [[ -e "$dir" && ! -d "$dir" ]]; then
    echo "状态目录不是目录（$dir）" >&2
    return 1
  fi
  # -m 和 -p 一起用只作用在最深那一层，父目录的权限仍是 umask；建完再 chmod 才是要的 755。
  mkdir -p -- "$dir" || return 1
  if [[ -L "$dir" || ! -d "$dir" ]]; then
    echo "状态目录不是目录（$dir）" >&2
    return 1
  fi
  chmod 755 -- "$dir" || return 1
  # 子 shell 里拿锁、读改写。exit 只出这个子 shell，不把调用方（测试 source 进来时）一起退掉。
  # 命令替换会吃掉结尾换行，写盘时补回一个。空文件和没有的文件不走 merge：空输入没有 v=1，会当成坏文件。
  (
    local body rc=0 stamp tmp
    if [[ -L "$dir" || -L "$file" || -L "$lock" ]]; then
      echo "状态文件或它的目录、锁是符号链接，不写（$file）" >&2
      exit 1
    fi
    # 追加打开：已有的锁不截断。拿不到锁就失败，不带着没锁的读改写往下做
    exec 9>>"$lock" || exit 1
    if ! flock -w 30 9; then
      echo "状态文件的锁 30 秒没拿到（$lock）" >&2
      exit 1
    fi
    if [[ -L "$file" ]]; then
      echo "状态文件是符号链接，不写（$file）" >&2
      exit 1
    fi
    if [[ -e "$file" && ! -f "$file" ]]; then
      echo "状态文件不是普通文件（$file）" >&2
      exit 1
    fi
    if [[ -e "$file" && ! -s "$file" ]]; then
      rm -f -- "$file" || exit 1
    fi
    if [[ ! -e "$file" ]]; then
      body=$(hk_status_fresh "$id" "$ok" "$at" "$summary")
    else
      body=$(hk_status_merge "$id" "$ok" "$at" "$summary" <"$file") || rc=$?
      if ((rc == 2)); then
        stamp=$(TZ=Asia/Shanghai date +%Y%m%dT%H%M%S) || exit 1
        mv -f -- "$file" "$file.bad-$stamp" || exit 1
        echo "状态文件不是 v=1，已挪到 $file.bad-$stamp" >&2
        body=$(hk_status_fresh "$id" "$ok" "$at" "$summary")
      elif ((rc != 0)); then
        exit "$rc"
      fi
    fi
    tmp=$(mktemp "$dir/.status.XXXXXX") || exit 1
    if ! printf '%s\n' "$body" >"$tmp"; then
      rm -f -- "$tmp"
      exit 1
    fi
    if ! chmod 644 -- "$tmp"; then
      rm -f -- "$tmp"
      exit 1
    fi
    mv -f -- "$tmp" "$file"
  )
}

# 打印某个检查的那一段（四行）。没有这个检查返回 1；文件读不到、是符号链接、没有 v=1 返回 2。
hk_status_get() { # id [文件]
  local id=$1 file=${2:-${HK_STATUS_FILE:-/var/lib/fleet-hk/status.json}}
  local line first=1 sec="" found=0
  if [[ -L "$file" || ! -f "$file" ]]; then
    echo "状态文件读不到（$file）" >&2
    return 2
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    if ((first)); then
      first=0
      if [[ "$line" != "v=1" ]]; then
        echo "状态文件没有 v=1" >&2
        return 2
      fi
      continue
    fi
    if [[ -z "$line" ]]; then
      if [[ "${sec%%$'\n'*}" == "check=$id" ]]; then
        found=1
        break
      fi
      sec=""
    else
      sec+="${sec:+$'\n'}$line"
    fi
  done <"$file"
  if [[ "${sec%%$'\n'*}" == "check=$id" ]]; then found=1; fi
  if ((found == 0)); then return 1; fi
  printf '%s\n' "$sec"
}
