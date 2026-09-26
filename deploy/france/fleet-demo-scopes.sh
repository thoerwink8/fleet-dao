#!/usr/bin/env bash
# 演示版的可见范围推到香港（法国，root 跑）。france.sh 把本文件装成 /usr/local/sbin/fleet-demo-scopes；
# fleet-demo-scopes.path 在范围目录一变就拉起它，fleet-demo-scopes.timer 每 10 分钟再补一次。
# 驾驶舱后端（fleet）把范围写在 /var/lib/fleet-dao/demo/scopes/：一条演示链接一个 <口令的 SHA-256>.json，
# 默认范围是 default.json。这里原样推到香港 <演示版路径>scopes/，演示版只读它（法国停了照样能看）：
# 发一条链接 = 多一个文件，作废、到期 = 少一个（--delete 跟着删）。
# 范围目录归 fleet，root 只当数据读：文件名、大小、内容都按后端写的样子认（packages/api/src/demo.ts），
# 认不出的不推——也就不会借符号链接把本机别的文件推上公网；推完照实退出 1，读回里会报红。
# 退出码：0 推好了；1 推了、但有认不出的文件没推；2 没推成（香港连不上、配置不对）。
set -Eeuo pipefail
umask 077
export LC_ALL=C

SRC=/var/lib/fleet-dao/demo/scopes
RELEASE_ENV=/etc/fleet-dao/release.env
UPLOAD_KEY=/etc/fleet-dao/web-upload.key
HK_KNOWN_HOSTS=/etc/fleet-dao/hk-known-hosts
HK_TUNNEL=10.99.0.1
# 可见范围的模块，同 packages/shared 的 DEMO_MODULES（deploy/test/demo-scopes.test.sh 拿后端真写出来的文件核对）
MODULES='board|task|dispatch|channels|quota|schedules|notifications|audit|settings'
M="\"($MODULES)\""
T='"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z"'
# 后端写的就是这个样子：JSON.stringify({ v, modules, detail, expiresAt? })，键的先后固定
SCOPE_RE="^[{]\"v\":1,\"modules\":[[]($M(,$M)*)?[]],\"detail\":\"(status|titles|process)\"(,\"expiresAt\":$T)?[}]$"
MAX_BYTES=4096

# 同 deploy/lib/common.sh 的 web_upload_ssh（本文件装到 /usr/local/sbin 单独跑，不引那份；测试核对两边一样）
hk_ssh() {
  printf 'ssh -i %s -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%s -o ConnectTimeout=10' \
    "$UPLOAD_KEY" "$HK_KNOWN_HOSTS"
}

# 同 deploy/lib/common.sh 的 hk_rsync（为什么要排队见那边；测试核对两边一样）：和发布脚本发静态文件排同一个队，
# 不然香港的 rrsync 会拒掉后到的那个
HK_RSYNC_LOCK=${FLEET_HK_RSYNC_LOCK:-/run/lock/fleet-dao-hk-rsync.lock}
HK_RSYNC_WAIT=120
hk_rsync() { # rsync 参数…
  (
    if ! flock -w "$HK_RSYNC_WAIT" 9; then
      echo "等了 $HK_RSYNC_WAIT 秒还没轮到往香港推文件：$HK_RSYNC_LOCK 一直被别的推送占着" >&2
      exit 75
    fi
    rsync "$@"
  ) 9>>"$HK_RSYNC_LOCK"
}

# 演示版在香港站点上的路径：release.env 的 FLEET_DEMO_PATH（同发布脚本），没写就是 /demo/
demo_path() {
  local line v=""
  if [[ -f "$RELEASE_ENV" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^FLEET_DEMO_PATH=\"?([^\"]*)\"?$ ]]; then v=${BASH_REMATCH[1]}; fi
    done <"$RELEASE_ENV"
  fi
  v=${v:-/demo/}
  if [[ ! "$v" =~ ^/[a-z0-9][a-z0-9-]*/$ ]]; then
    echo "$RELEASE_ENV 的 FLEET_DEMO_PATH 应为 /demo/ 这样的一级路径，现在是「$v」" >&2
    return 1
  fi
  printf '%s' "$v"
}

# 范围目录此刻的样子（名字、大小、修改时刻）：推完再看一眼，推的过程中变过就再推一轮
listing() {
  if [[ -d "$SRC" ]]; then find "$SRC" -maxdepth 1 -mindepth 1 -printf '%f %s %T@\n' | sort; fi
}

# 认得的文件抄进暂存目录（root 的）的 scopes/ 下；认不出的记进 SKIPPED
SKIPPED=()
stage_scopes() { # 暂存目录
  local stage=$1/scopes f name body
  SKIPPED=()
  mkdir -p -- "$stage"
  if [[ ! -d "$SRC" ]]; then return 0; fi
  for f in "$SRC"/* "$SRC"/.[!.]*; do
    if [[ ! -e "$f" && ! -L "$f" ]]; then continue; fi
    name=${f##*/}
    if [[ ! "$name" =~ ^([0-9a-f]{64}|default)[.]json$ ]]; then
      SKIPPED+=("$name（名字不对）")
      continue
    fi
    if [[ -L "$f" || ! -f "$f" ]]; then
      SKIPPED+=("$name（不是普通文件）")
      continue
    fi
    # 读的那一下被换成了链接、管道也不怕：只读头 MAX_BYTES+1 个字节、5 秒为限，内容不对就不推
    if ! body=$(timeout 5 head -c $((MAX_BYTES + 1)) -- "$f" 2>/dev/null); then
      SKIPPED+=("$name（读不出）")
      continue
    fi
    if ((${#body} > MAX_BYTES)); then
      SKIPPED+=("$name（超过 $MAX_BYTES 字节）")
      continue
    fi
    if [[ ! "$body" =~ $SCOPE_RE ]]; then
      SKIPPED+=("$name（内容不是可见范围）")
      continue
    fi
    printf '%s\n' "$body" >"$stage/$name"
  done
}

# 推到香港演示版目录下的 scopes/：只碰 scopes/ 里的 .json（演示版别的文件由发布脚本管，这里一个不动；
# 演示版的目录还没有时顺手建上）。里面不是这一份的文件删掉：作废、到期就是这么生效的
push() { # 暂存目录 香港上演示版的路径
  hk_rsync -rpc --delete --delay-updates --chmod=D755,F644 --itemize-changes \
    --include=/scopes/ --include='/scopes/*.json' --exclude='*' \
    -e "$(hk_ssh)" -- "$1/" "root@$HK_TUNNEL:$2"
}

main() {
  local path stage before after n round out
  if ! path=$(demo_path); then exit 2; fi
  for round in 1 2 3 4 5; do
    before=$(listing)
    stage=$(mktemp -d)
    stage_scopes "$stage"
    n=$(find "$stage/scopes" -type f | wc -l)
    if ! out=$(push "$stage" "$path" 2>&1); then
      rm -rf -- "$stage"
      echo "推到香港 ${path}scopes/ 没成：$(tail -3 <<<"$out" | tr '\n' ' ')" >&2
      exit 2
    fi
    rm -rf -- "$stage"
    after=$(listing)
    if [[ "$before" == "$after" ]]; then break; fi
    echo "推的时候范围目录又变了，再推一轮（第 $round 轮）"
  done
  echo "香港 ${path}scopes/ 现在是 $n 份可见范围$(if [[ -n "$out" ]]; then echo "（这次有 $(grep -c . <<<"$out") 处变化）"; fi)"
  if ((${#SKIPPED[@]})); then
    printf '有 %d 个文件认不出、没推：%s\n' "${#SKIPPED[@]}" "${SKIPPED[*]}" >&2
    exit 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
