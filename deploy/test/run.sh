#!/usr/bin/env bash
# deploy/ 的全部检查：语法、shellcheck、自检的违规样本、发布脚本的来回（换版、自动退回、只留几版、飞书网关发不发）、
# 香港网关入口（fleet-gateway-deploy）、飞书网关打包、静态文件发到香港哪几处（演示版、根地址、可见范围不删）、
# 演示版照「上次发的是哪一版」的记录核对（自动发布不发也照样查，坏了要红）、
# 演示版的可见范围推到香港、公网上看得到的几样（占位页、健康页不带真名，release.json 只给隧道，整站不让搜索引擎收录）、
# 健康页的判定、自动发布的判断和流程（auto-release：CI 红不发、读不到不发、没成不重试、等空闲、人手动切过不动）、
# 配置对账（config：线上手改报哪一项、私有值只报不一致不带值、期望和钥匙读不到记没查成；本机档和法国的期望
# 逐项比、versions 钉死几个大版本、没登记的差别报红，也在这个文件里）、
# 本机档（profile：FLEET_PROFILE 认不认得出、不带就是 france、is_local_profile、skip_local 只进 PENDING）、
# france.sh 读回自动发布跑得怎么样（auto-release-state：没跑过、读不了、读到了分得清）、
# 库只听回环的判定（listen：IPv4 回环一个也算，多出别的地址、一个都没读到判不是）、
# 法国只有一个会话用户且读回拦得下故意造的错（session-user）、AI 会话用的 pnpm 的装和查（session-pnpm）、
# 会话用户的 cursor-agent 的装和查（cursor-agent）、会话用户的 Cursor 密钥的放、查、撤（cursor-key）、
# 会话用户的 grok 命令行的装和查、登录态的读回（grok）、会话用户自己的 Mirasim 服务的读回（mirasim，#345；
# 装、登录要创始人在自己电脑上做，这里只查 ~/.mirasim/run 下的令牌）、Mirasim 常驻单元该不该装、装了活没活
# （mirasim-session，#424：服务端本体没装待配、不装单元；装了单元不活或 /api/health 不通判红）、
# 切会话用户挂的 reclaude 组织（agent-scope-org-use）、本机档发布取代码、装依赖经这一档登记的会话代理（release-proxy，#786）、
# node 的编译缓存目录归 root、别人放不进（node-cache）、会话用户在本机开的口只许它自己和 root 连（session-ports，#35）、
# 本机档 WSL 的回环留在本机、只空出 Windows 上代理的口（wsl-loopback，#731：照 WSL 的样子摆好策略路由真跑，装机第 1 步的装和读回）、
# docs/ops.md 端口表和脚本对得上、docs/ops.md 里放文件的命令收到空的或半截的不换（place-file）、--ops 真跑了这两块（ops-only）、
# 分台名单没漏没重（shards）。
# 用法：sudo bash deploy/test/run.sh（违规样本那项要 root）。退出码：0 通过，1 有不通过，2 有没跑成的。
#   bash deploy/test/run.sh --shard 2/3：只跑第 2 台那几项。CI 把全套切成 3 台并行跑（ci-plan.ts 的 DEPLOY_SHARDS），不带 --shard
#     就是三台依次全跑（本机、装机时用）。每一项跑完打一行「⏱ 名字 N 秒」，重新分台就照这个数。
#   bash deploy/test/run.sh --ops：只跑读 docs/ops.md 的两块（端口表、place-file），CI 只改了 ops.md 时用（ci-plan.ts 的 deploy=ops）。
#   bash deploy/test/run.sh --check-shards：只核分台名单（每个测试文件恰好排进一台），不跑测试。
# 改这里之前必须知道：
# - deploy/test 里新加读 docs/ops.md 的检查，要同时进 --ops 那条路（ops_checks），否则只改 ops.md 的 PR 测不到它；
#   ops-only.test.sh 核对 --ops 真跑了这两块、改坏 ops.md 会红。
# - deploy/test 里新加一个 *.test.sh（或 *.test.mjs），要写进下面 SHARDS 的某一台（node 的写进 NODE_TESTS）：每次跑（每一台）都先核
#   「每个测试文件恰好排进一台」，漏了、排了两台、排了不存在的都红，不会悄悄不跑（shards.test.sh 故意造这几种错核对）。
#   台数改了，ci-plan.ts 的 DEPLOY_SHARDS 跟着改（packages/conventions/test/ci-plan.test.ts 核对两边一样）。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
OPS=$DEPLOY/../docs/ops.md
fail=0
skipped=0
only_ops=0
check_shards_only=0
shard_i=0 # 0 = 不分台，三台依次全跑
shard_n=0

# 分台：SHARDS 的每一项是一台，里面是用空格隔开的项目名。项目名 = deploy/test 下 *.test.sh 去掉后缀；另有四个特殊项：
# lint（语法 + shellcheck）、backup（deploy/backup/test）、node-tests（下面 NODE_TESTS 那几个 node --test）、ports（端口表）。
# 按 CI 实测的耗时（2026-10-03，一整套 300 秒上下）搭，三台各 100 秒上下。
# 2026-10-03 超时可注入之后的实测（主线 ci.yml 一轮）：login-user 94→44 秒、cli-tools 约 34 秒；三台原先 61 / 66 / 140 秒，
# 第三台拖后腿，把 session-ports、web-publish、release-flow 挪去第一台，grok、public-site、agent-scope-org-use 挪去第二台，
# 估三台各 80–100 秒。第二轮实测三台 101 / 84 / 95 秒，再把 release-flow、web-publish 从第一台挪去第三台。挪完看下一轮 CI 的「⏱」行，不匀了再挪。每一项的秒数都看日志里的「⏱」行。
SHARDS=(
  'login-user session-user listen root-exec-check gateway-deploy ops-only ports shards profile session-ports release-proxy'
  'cli-tools cursor-agent cursor-key mirasim mirasim-session node-cache agent-scope-adopt app-config grok public-site agent-scope-org-use wsl-loopback'
  'lint session-pnpm demo-scopes gateway-bundle backup place-file auto-release-state agents-sync agents-sync-account node-tests release-flow web-publish'
)
NODE_TESTS=(health-page auto-release config)
SPECIAL_UNITS=(lint backup node-tests ports)

usage_error() {
  echo "没跑成：$1"
  exit 2
}

while (($#)); do
  case "$1" in
  --ops)
    only_ops=1
    shift
    ;;
  --check-shards)
    check_shards_only=1
    shift
    ;;
  --shard)
    [[ "${2-}" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || usage_error "--shard 要写成 第几台/共几台（比如 2/3），现在是「${2-}」"
    shard_i=${BASH_REMATCH[1]}
    shard_n=${BASH_REMATCH[2]}
    shift 2
    ;;
  *) usage_error "认不出的参数「$1」（只认 --ops、--shard i/n、--check-shards）" ;;
  esac
done
if ((shard_i)); then
  if ((only_ops)); then usage_error "--ops 和 --shard 不能一起用"; fi
  if ((shard_n != ${#SHARDS[@]})); then
    usage_error "--shard 说共 $shard_n 台，这个脚本里分的是 ${#SHARDS[@]} 台（ci-plan.ts 的 DEPLOY_SHARDS 要和它一样）"
  fi
  if ((shard_i > shard_n)); then usage_error "--shard 第 $shard_i 台，可是只有 $shard_n 台"; fi
fi

# 端口表：脚本里定的每个端口号都要出现在 docs/ops.md 里（改了端口忘了改文档，这里会红）
check_ports() {
  local ports missing p
  ports=$(grep -hoE '^[A-Z_]*PORT=[0-9]+' "$DEPLOY/france.sh" "$DEPLOY/hk.sh" | cut -d= -f2 | sort -u)
  if [[ -z "$ports" ]]; then
    echo "没跑成：脚本里一个端口都没读到"
    skipped=1
    return
  fi
  missing=""
  for p in $ports; do
    if ! grep -qw -- "$p" "$OPS"; then missing+=" $p"; fi
  done
  if [[ -n "$missing" ]]; then
    echo "不通过：docs/ops.md 的端口表里没有$missing"
    fail=1
  else
    echo "端口表：$(wc -w <<<"$ports") 个端口都在 docs/ops.md 里"
  fi
}

run_script() { # 脚本的完整路径：0 过、2 没跑成、别的不通过
  bash "$1"
  case $? in
  0) ;;
  2) skipped=1 ;;
  *) fail=1 ;;
  esac
}

run_test() { run_script "$HERE/$1"; } # 测试脚本（相对 deploy/test）

finish() {
  if ((fail)); then exit 1; fi
  if ((skipped)); then exit 2; fi
  echo "$1"
  exit 0
}

shard_units() { # 第几台（从 1 数）的项目名，一行一个
  local -a names
  read -ra names <<<"${SHARDS[$(($1 - 1))]}"
  printf '%s\n' "${names[@]}"
}

# 每个测试文件恰好排进一台：漏了的（新加的测试没人跑）、排了两台的、排了却没有这个文件的，都不通过。
check_shard_coverage() {
  local listed listed_u expected dup missing extra f b k ok=1
  listed=$(for ((k = 1; k <= ${#SHARDS[@]}; k++)); do shard_units "$k"; done | sort)
  listed_u=$(sort -u <<<"$listed")
  expected=$(
    for f in "$HERE"/*.test.sh; do
      [[ -e "$f" ]] || continue
      b=${f##*/}
      echo "${b%.test.sh}"
    done
    printf '%s\n' "${SPECIAL_UNITS[@]}"
  )
  expected=$(sort <<<"$expected")
  dup=$(uniq -d <<<"$listed")
  missing=$(comm -13 <(echo "$listed_u") <(echo "$expected"))
  extra=$(comm -23 <(echo "$listed_u") <(echo "$expected"))
  if [[ -n "$missing" ]]; then
    echo "不通过：这些测试没排进任何一台（写进 run.sh 的 SHARDS 里，不然不会有人跑）：$(tr '\n' ' ' <<<"$missing")"
    ok=0
  fi
  if [[ -n "$dup" ]]; then
    echo "不通过：这些项排了不止一台：$(tr '\n' ' ' <<<"$dup")"
    ok=0
  fi
  if [[ -n "$extra" ]]; then
    echo "不通过：这些项排进了台，却没有这个测试文件：$(tr '\n' ' ' <<<"$extra")"
    ok=0
  fi
  for f in "$HERE"/*.test.mjs; do
    [[ -e "$f" ]] || continue
    b=${f##*/}
    b=${b%.test.mjs}
    if [[ " ${NODE_TESTS[*]} " != *" $b "* ]]; then
      echo "不通过：node 测试 $b.test.mjs 没登记进 NODE_TESTS，不会有人跑"
      ok=0
    fi
  done
  for b in "${NODE_TESTS[@]}"; do
    if [[ ! -e "$HERE/$b.test.mjs" ]]; then
      echo "不通过：NODE_TESTS 里的 $b 没有 $b.test.mjs"
      ok=0
    fi
  done
  if ((ok)); then
    echo "分台名单：${#SHARDS[@]} 台，$(wc -l <<<"$listed_u") 项，每个测试文件恰好排进一台"
  else
    fail=1
  fi
}

# 语法 + shellcheck。shellcheck 一个个跑要 40 多秒，切成每 8 个一批、几批并行；任何一批不是 0 都算不通过。
unit_lint() {
  local -a scripts
  local f
  mapfile -t scripts < <(find "$DEPLOY" -name '*.sh' | sort)
  for f in "${scripts[@]}"; do
    if ! bash -n "$f"; then
      echo "不通过：语法错 $f"
      fail=1
    fi
  done
  echo "语法：查了 ${#scripts[@]} 个脚本"
  if command -v shellcheck >/dev/null; then
    if printf '%s\0' "${scripts[@]}" | xargs -0 -n 8 -P "$(nproc 2>/dev/null || echo 2)" shellcheck -x -S style; then
      echo "shellcheck：通过"
    else
      fail=1
    fi
  else
    echo "没跑成：这台没有 shellcheck"
    skipped=1
  fi
}

unit_node_tests() {
  if command -v node >/dev/null; then
    if node --test "$HERE/health-page.test.mjs"; then echo "健康页的判定：通过"; else fail=1; fi
    if node --test "$HERE/reclaude-old-account-clean.test.mjs"; then echo "被封号邮箱清理：通过"; else fail=1; fi
    if node --test "$HERE/auto-release.test.mjs"; then echo "自动发布的判断和流程：通过"; else fail=1; fi
    if node --test "$HERE/config.test.mjs"; then echo "配置对账（期望进仓、私有值只比指纹）：通过"; else fail=1; fi
  else
    echo "没跑成：这台没有 node，健康页的判定、自动发布没测"
    skipped=1
  fi
}

run_unit() { # 项目名
  local unit=$1 t0=$SECONDS
  case "$unit" in
  lint) unit_lint ;;
  backup) run_script "$DEPLOY/backup/test/backup.test.sh" ;;
  node-tests) unit_node_tests ;;
  ports) check_ports ;;
  *) run_test "$unit.test.sh" ;;
  esac
  echo "⏱ $unit $((SECONDS - t0)) 秒"
}

# 先核名单（--ops 也核：#662 第二意见第 2 轮指出这条路原来跳过了它，新加个测试没人跑也不报）。
check_shard_coverage
if ((check_shards_only)); then
  finish "分台名单核对通过"
fi

# --ops 只跑读 ops.md 的两块：也走 run_unit，和全套一样打耗时行（口径一致，重新分台时看得出每项多少钱）。
if ((only_ops)); then
  run_unit ports
  run_unit place-file
  finish "deploy/ 里读 docs/ops.md 的两块（端口表、place-file）通过"
fi

units=()
if ((shard_i)); then
  mapfile -t units < <(shard_units "$shard_i")
  label="第 $shard_i/$shard_n 台"
else
  for ((s = 1; s <= ${#SHARDS[@]}; s++)); do
    mapfile -t more < <(shard_units "$s")
    units+=("${more[@]}")
  done
  label="全部"
fi
for u in "${units[@]}"; do run_unit "$u"; done

finish "deploy/ 检查（$label）全部通过"
