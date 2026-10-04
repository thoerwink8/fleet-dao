#!/usr/bin/env bash
# fleet-agent-scope 的 org-use 子命令（#157：切会话用户挂的 reclaude 组织）。不要 root、不要真的会话用户：
# AGENT_SCOPE_TEST_AS_USER=direct 不降权直接跑，AGENT_SCOPE_TEST_HOME 给一个临时家目录，AGENT_SCOPE_TEST_RECLAUDE 换成假的
# reclaude（状态在那个家目录的 .fake-reclaude 下：挂着哪个、org use 这一下怎么表现）。每种没切成的路径都故意造一遍：
# org list 读不了、认不出、带 * 的不是恰好一行、那一类的组织不是恰好一个、org use 退出码 1 却切了（CC-07）、退出码 0 却没切、
# 切错了往回切、往回切也没成、切完回读核对不了；输出里一律搜不到组织编号和邮箱。
# 切号给 reclaude 带的环境（#786）：照这一档期望登记的会话代理带上（本机档是 Clash 的口、法国登记成空＝直连、认不出就不带），
# 调用者环境里的同名变量一律不认；那几条要 node（照期望读代理，这台没有就记「没跑成」）。
# 法国真机上以 root 经 setpriv 降成会话用户那一段由 deploy/test/agent-scope.e2e.sh 那一类真机演练看（#157 结果里记）。
# 用法：bash deploy/test/agent-scope-org-use.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BIN=$HERE/../france/fleet-agent-scope.sh
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
fail=0
skipped=0 # 有要 node 的那几条没跑成时置 1（退出码 2，不当成通过）
pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}

# 假 reclaude：env -i 以后只剩 HOME 这几样，状态放在 $HOME/.fake-reclaude 下。
#   orgs：一行一个「编号<Tab>名字<Tab>类型<Tab>邮箱」；current：现在挂的编号；calls：每次调用的参数
#   list-exit：有就让 org list 以这个退出码失败；list-fail-after-use：org use 跑过以后 org list 失败；syncing：先打一行 Syncing
#   use-mode：第一次 org use 怎么表现（ok、exit1-switched、exit1-noswitch、exit0-noswitch、wrong）；rollback-fails：往回切不生效
#   list-hang-after-use：org use 跑过以后 org list 卡住不回；slow-list：org use 之前的 org list 先睡这么多秒
#   list-fail-once-after-use：org use 跑过以后头一次 org list 失败、之后好了
FAKE=$TMP/fake-reclaude
cat >"$FAKE" <<'SH'
#!/usr/bin/env bash
S=$HOME/.fake-reclaude
echo "$*" >>"$S/calls"
# 每一次调用看到的环境里代理相关的几项（#786）：org-use 给 reclaude 的环境是 env -i 清的，本机档要经登记的代理
# 才连得上，法国一个都不该有。一次调用记一块（$S/env 里一次调用一段），下面只看最后一段
if [[ -e "$S/env" ]]; then
  echo "--" >>"$S/env"
  for k in HOME http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY FLEET_SESSION_PROXY; do
    eval "v=\${$k-<未设>}"
    echo "$k=$v" >>"$S/env"
  done
fi
if [[ "${1:-} ${2:-}" == "org list" ]]; then
  if [[ -f "$S/list-exit" ]]; then
    echo "boom: org 1111 of someone@example.com" >&2
    exit "$(cat "$S/list-exit")"
  fi
  if [[ -f "$S/list-fail-after-use" && -f "$S/used" ]]; then
    echo "dial tcp: connection refused" >&2
    exit 7
  fi
  # 切完头一次读失败、之后好了（一次网络抖动）
  if [[ -f "$S/list-fail-once-after-use" && -f "$S/used" && ! -f "$S/failed-once" ]]; then
    touch "$S/failed-once"
    echo "dial tcp: i/o timeout" >&2
    exit 7
  fi
  # 切完再读就卡住（exec：timeout 的 TERM 直接落到 sleep 上，不留孤儿进程占着输出管道）
  if [[ -f "$S/list-hang-after-use" && -f "$S/used" ]]; then exec sleep 60; fi
  # 切之前读得慢（像 reclaude 首跑同步配置）：睡这么多秒再答
  if [[ -f "$S/slow-list" && ! -f "$S/used" ]]; then sleep "$(cat "$S/slow-list")"; fi
  if [[ -f "$S/syncing" ]]; then echo "Syncing config…"; fi
  echo "Available organizations:"
  cur=$(cat "$S/current")
  while IFS=$'\t' read -r id name type email; do
    [[ -n "$id" ]] || continue
    if [[ "$id" == "$cur" ]]; then m='*'; else m=' '; fi
    printf '%s %s\t%s\t%s\t%s\n' "$m" "$id" "$name" "$type" "$email"
  done <"$S/orgs"
  echo "Switch organization: (see help)"
  exit 0
fi
if [[ "${1:-} ${2:-}" == "org use" ]]; then
  if [[ -f "$S/used" ]]; then
    # 第二次起是往回切
    if [[ -f "$S/rollback-fails" ]]; then
      echo "rollback refused for org $3" >&2
      exit 1
    fi
    echo "$3" >"$S/current"
    exit 0
  fi
  touch "$S/used"
  case $(cat "$S/use-mode" 2>/dev/null || echo ok) in
  ok) echo "$3" >"$S/current" ;;
  exit1-switched)
    echo "$3" >"$S/current"
    echo "sync current account: unexpected status 500 for org $3" >&2
    exit 1
    ;;
  exit1-noswitch)
    echo "org $3 of someone@example.com: account_banned" >&2
    exit 1
    ;;
  exit0-noswitch) : ;;
  wrong) echo 3333 >"$S/current" ;;
  esac
  exit 0
fi
echo "unknown command" >&2
exit 2
SH
chmod +x "$FAKE"
export AGENT_SCOPE_TEST_AS_USER=direct AGENT_SCOPE_TEST_RECLAUDE=$FAKE

# 这一档登记的会话代理（#786）：脚本要 source 仓里 deploy/lib/profile.sh，还要照这台记的档位挑期望，两处都显式给
# （脚本装到 /usr/local/sbin/，仓里那份只能显式指；档位文件默认在 /etc/fleet-dao/profile，测试机上不能碰）
export AGENT_SCOPE_TEST_DEPLOY=$HERE/..
export AGENT_SCOPE_TEST_PROFILE_FILE=$TMP/profile

CARPOOL=1111
SOLO=2222
OTHER=3333
setup() { # 现在挂的编号：新的家目录和状态（一个拼车、一个独享）
  HOME_DIR=$(mktemp -d "$TMP/home.XXXXXX")
  S=$HOME_DIR/.fake-reclaude
  mkdir -p "$S"
  printf '%s\t某拼车组织\tteam\tsomeone@example.com\n%s\t某独享组织\tpersonal\tsomeone@example.com\n' "$CARPOOL" "$SOLO" >"$S/orgs"
  echo "$1" >"$S/current"
  : >"$S/calls"
  export AGENT_SCOPE_TEST_HOME=$HOME_DIR
}
run() { # 参数…：跑 org-use。LAST 是标准输出最后一行，OUT 是标准输出加标准错误，RC 是退出码
  local out
  out=$(bash "$BIN" org-use "$@" 2>"$TMP/err")
  RC=$?
  LAST=$(printf '%s\n' "$out" | tail -n 1)
  OUT="$out"$'\n'"$(cat "$TMP/err")"
}
current() { cat "$S/current"; }
uses() { grep -c '^org use' "$S/calls" || true; }
expect() { # 说明 退出码 最后一行 [输出里要有的一句]：再看输出里搜不到编号和邮箱
  local what=$1 rc=$2 last=$3 has=${4:-}
  if [[ "$RC" != "$rc" || "$LAST" != "$last" ]]; then
    flunk "$what：应退出码 $rc、最后一行「$last」，实际 $RC、「$LAST」（输出「$OUT」）"
  elif [[ -n "$has" && "$OUT" != *"$has"* ]]; then
    flunk "$what：输出里应有「$has」：「$OUT」"
  elif [[ "$OUT" == *"$CARPOOL"* || "$OUT" == *"$SOLO"* || "$OUT" == *"$OTHER"* || "$OUT" == *"@example.com"* ]]; then
    flunk "$what：输出里带了组织编号或邮箱：「$OUT」"
  else
    pass "$what"
  fi
}

echo "== 校验不过：退出码 64，什么都不跑"
setup "$SOLO"
for args in "" "team --user fleet-agent-carpool" "carpool" "carpool --user nobody" "carpool --user" "carpool --user fleet-agent-carpool --force"; do
  # shellcheck disable=SC2086 # 故意按空格拆成几个参数
  run $args
  if [[ "$RC" == 64 && "$(uses)" == 0 && ! -s "$S/calls" ]]; then
    pass "「org-use $args」退出码 64，没碰 reclaude"
  else
    flunk "「org-use $args」应退出码 64、不碰 reclaude：退出码 $RC，调用「$(cat "$S/calls")」"
  fi
done

echo "== 切成"
setup "$SOLO"
run carpool --user fleet-agent-carpool
expect "挂独享、切到拼车：切成" 0 "switched carpool" "已从独享组织切到拼车组织"
[[ "$(current)" == "$CARPOOL" && "$(uses)" == 1 ]] || flunk "应只 org use 一次、切到拼车：现在 $(current)，org use $(uses) 次"

setup "$CARPOOL"
touch "$S/syncing"
run solo --user fleet-agent-carpool
expect "前面先打 Syncing config…：照样认得，切到独享" 0 "switched solo"
[[ "$(current)" == "$SOLO" ]] || flunk "应切到独享：现在 $(current)"

setup "$CARPOOL"
run carpool --user fleet-agent-carpool
expect "已经挂着拼车：不切" 0 "already carpool" "不用切"
[[ "$(uses)" == 0 ]] || flunk "已经挂着就不该 org use：用了 $(uses) 次"

setup "$SOLO"
echo exit1-switched >"$S/use-mode"
run carpool --user fleet-agent-carpool
expect "org use 退出码 1 却切了（CC-07）：回读认成切成" 0 "switched carpool"
[[ "$(uses)" == 1 ]] || flunk "切成了就不该往回切：org use $(uses) 次"

echo "== 没切成：退出码 1，照实说现在挂的是哪个"
setup "$SOLO"
echo exit1-noswitch >"$S/use-mode"
run carpool --user fleet-agent-carpool
expect "org use 退出码 1、没切：还在独享" 1 "failed solo" "现在挂的还是原来的独享组织"
[[ "$(uses)" == 1 && "$(current)" == "$SOLO" ]] || flunk "没挪动就不该往回切：org use $(uses) 次，现在 $(current)"

setup "$SOLO"
echo exit0-noswitch >"$S/use-mode"
run carpool --user fleet-agent-carpool
expect "org use 退出码 0 却没切：不当成切好了" 1 "failed solo" "org use 退出码 0"

setup "$SOLO"
printf '%s\t别的组织\tteam-plus\tsomeone@example.com\n' "$OTHER" >>"$S/orgs"
echo wrong >"$S/use-mode"
run carpool --user fleet-agent-carpool
expect "切到了别的组织：切回原来的独享" 1 "failed solo" "现在挂的还是原来的独享组织"
[[ "$(uses)" == 2 && "$(current)" == "$SOLO" ]] || flunk "应往回切一次、回到独享：org use $(uses) 次，现在 $(current)"

setup "$SOLO"
printf '%s\t别的组织\tteam-plus\tsomeone@example.com\n' "$OTHER" >>"$S/orgs"
echo wrong >"$S/use-mode"
touch "$S/rollback-fails"
run carpool --user fleet-agent-carpool
expect "切错了、往回切也没成：说清现在挂的是认不出类型的组织" 1 "failed other" "也没回到原来的独享组织"

setup "$SOLO"
touch "$S/list-fail-once-after-use"
run carpool --user fleet-agent-carpool
expect "切完回读核对不了（其实切成了）：只认正面证据，切回原来的独享、再读照实说" 1 "failed solo" "已切回原来的独享组织"
[[ "$(uses)" == 2 && "$(current)" == "$SOLO" ]] || flunk "核对不了应往回切一次、回到独享：org use $(uses) 次，现在 $(current)"

setup "$SOLO"
touch "$S/list-fail-after-use"
run carpool --user fleet-agent-carpool
expect "切完回读核对不了、切回去以后也读不了：不知道挂的是哪个" 1 "failed unknown" "不知道现在挂的是哪个"
[[ "$(uses)" == 2 ]] || flunk "核对不了应试着往回切一次：org use $(uses) 次"

echo "== org list 读不了、认不出：不切，退出码 1"
setup "$SOLO"
echo 3 >"$S/list-exit"
run carpool --user fleet-agent-carpool
expect "org list 退出码 3：没切" 1 "failed unknown" "org list 没跑成"
[[ "$(uses)" == 0 ]] || flunk "读不了组织就不该 org use：用了 $(uses) 次"

setup "none"
run carpool --user fleet-agent-carpool
expect "哪一行都不带 *：认不出现在挂的是哪个" 1 "failed unknown" "带 * 的有 0 行"

setup "$SOLO"
printf '%s\t又一个拼车\tteam\tsomeone@example.com\n' "$OTHER" >>"$S/orgs"
run carpool --user fleet-agent-carpool
expect "拼车类型的组织有两个：不知道切哪个" 1 "failed solo" "拼车类型的组织有 2 个"
[[ "$(uses)" == 0 ]] || flunk "认不出切哪个就不该 org use：用了 $(uses) 次"

setup "$SOLO"
printf '%s\t某独享组织\tpersonal\tsomeone@example.com\n' "$SOLO" >"$S/orgs"
run carpool --user fleet-agent-carpool
expect "一个拼车组织都没有：不切" 1 "failed solo" "拼车类型的组织有 0 个"

setup "$SOLO"
: >"$S/orgs"
run carpool --user fleet-agent-carpool
expect "org list 里一个组织都认不出：不切" 1 "failed unknown" "一个组织都认不出"

echo "== 总时限：每一步只给剩下的时间，调用方（等 300 秒）不会半道掐掉它"
# 总时限 10 秒、给核对留 4 秒：切之前那次读花了 3 秒，剩 7 秒，扣掉 KILL 的 5 秒余量和 4 秒就不够切了
setup "$SOLO"
echo 3 >"$S/slow-list"
export AGENT_SCOPE_TEST_ORG_BUDGET=10 AGENT_SCOPE_TEST_ORG_RESERVE=4
run carpool --user fleet-agent-carpool
expect "读得慢、剩下的时间不够切完再核对：不切，照实说还挂着独享" 1 "failed solo" "不够切完再核对，没切"
[[ "$(uses)" == 0 && "$(current)" == "$SOLO" ]] || flunk "时间不够就不该 org use：用了 $(uses) 次，现在 $(current)"
# 总时限 8 秒：切完回读卡住，到剩下的时间（8 - 5 = 3 秒）就被停，照实报不知道挂的是哪个，整个在总时限里收场
setup "$SOLO"
touch "$S/list-hang-after-use"
export AGENT_SCOPE_TEST_ORG_BUDGET=8 AGENT_SCOPE_TEST_ORG_RESERVE=1
started=$SECONDS
run carpool --user fleet-agent-carpool
took=$((SECONDS - started))
expect "切完回读卡住：到总时限就停，不知道挂的是哪个" 1 "failed unknown" "超时被停"
((took <= 8)) || flunk "应在总时限 8 秒里收场：用了 $took 秒"
# 核对不了本该往回切，可时间已经不够了：不跑（不越过总时限）
[[ "$(uses)" == 1 ]] || flunk "时间用完就不该再 org use：用了 $(uses) 次"
unset AGENT_SCOPE_TEST_ORG_BUDGET AGENT_SCOPE_TEST_ORG_RESERVE

echo "== 切号给 reclaude 带的环境：照这一档登记的会话代理（#786）"
# 本机档（fleet-local）的 WSL 直连 reclaude.ai 不通、要经 Windows 上 Clash 的口；切号给 reclaude 的环境是 env -i 清的，
# 不带就切不了号（实测 context deadline exceeded）。法国登记的代理是空＝直连，一个代理变量都不许出现。
# 桩每一次调用记一段（以 -- 开头），这里只看最后一段（切一次要调 org list 几次）
last_env() { awk '/^--$/{n=0; buf=""} {if (n++) buf=buf $0 "\n"} END{printf "%s", buf}' "$S/env" 2>/dev/null; }
# 最后一段里某个变量是什么（没记到就是空）
env_of() { grep -E "^$1=" <<<"$(last_env)" | tail -1 | cut -d= -f2-; }
# 最后一段里真正带上了的代理变量（一行一项）；桩把「没有这一项」记成 X=<未设>，那种不算带上
proxy_envs() {
  grep -E '^([Hh][Tt][Tt][Pp][Ss]?|[Nn][Oo])_[Pp][Rr][Oo][Xx][Yy]=|^FLEET_SESSION_PROXY=' <<<"$(last_env)" |
    grep -v '=<未设>$' | sort
}
# 调用者（root）自己环境里碰巧有代理：一个都不该带进去（#731 同一条规矩）
export https_proxy=http://caller-env.invalid:1 http_proxy=http://caller-env.invalid:1
export FLEET_SESSION_PROXY=http://caller-env.invalid:1

rm -f -- "$TMP/profile"
setup "$SOLO"
: >"$S/env"
run carpool --user fleet-agent-carpool
expect "法国（没有档位文件）：照常切成" 0 "switched carpool"
# 诊断（临时）：CI 上读不出代理时，看脚本用的是哪个 node、期望挑的是哪一份、为什么没读成
{
  echo "  … 调试：command -v node=$(command -v node 2>&1) PATH=$PATH"
  echo "  … 调试：对同一份期望直接叫 session_proxy_load"
  AGENT_SCOPE_DEPLOY=$AGENT_SCOPE_TEST_DEPLOY bash -c '
    source "$AGENT_SCOPE_DEPLOY/lib/profile.sh"
    echo "      SESSION_PROXY_NODE=$SESSION_PROXY_NODE PROFILE=${PROFILE:-（未设）}"
    if [[ -f "$AGENT_SCOPE_TEST_PROFILE_FILE" ]]; then echo "      档位文件=$(<"$AGENT_SCOPE_TEST_PROFILE_FILE")"; else echo "      档位文件不在"; fi
    if session_proxy_load; then echo "      读到=$SESSION_PROXY"; else echo "      读不到=$SESSION_PROXY_WHY"; fi' 2>&1
}

if [[ -z "$(proxy_envs)" ]]; then
  pass "法国：reclaude 的环境里一个代理变量都没有（调用者环境里的、FLEET_SESSION_PROXY 都带不进去）"
else
  flunk "法国不该带代理，实际带了：「$(proxy_envs | tr '\n' ' ')」"
fi
if [[ "$(last_env)" == *"caller-env.invalid"* ]]; then
  flunk "调用者环境里的代理漏进了 reclaude 的环境：「$(last_env | tr '\n' ' ')」"
else
  pass "法国：调用者环境里的代理没漏进去"
fi
if grep -q '^HOME=' <<<"$(last_env)"; then
  pass "法国：环境还是清的（HOME 还在，只有那几样）"
else
  flunk "法国：环境不像 env -i 那样只有那几样"
fi

# 本机档：照 deploy/local/desired-config.json 读出 Clash 的口，http(s)_proxy 大小写各一份 + no_proxy 只放本机回环
PROXY_URL=http://127.0.0.1:7890
NO_PROXY_VALUE=localhost,127.0.0.1,::1
printf 'local\n' >"$TMP/profile"
setup "$SOLO"
: >"$S/env"
run carpool --user fleet-agent-carpool
expect "本机档：照常切成" 0 "switched carpool"
# 六项：大小写各一份，no_proxy/NO_PROXY 只放本机回环（变量名的顺序照 profile.sh 里摆的来）
got_envs=$(printf '%s\n' \
  "http_proxy=$(env_of http_proxy)" "https_proxy=$(env_of https_proxy)" \
  "HTTP_PROXY=$(env_of HTTP_PROXY)" "HTTPS_PROXY=$(env_of HTTPS_PROXY)" \
  "no_proxy=$(env_of no_proxy)" "NO_PROXY=$(env_of NO_PROXY)")
want=$(printf 'http_proxy=%s\nhttps_proxy=%s\nHTTP_PROXY=%s\nHTTPS_PROXY=%s\nno_proxy=%s\nNO_PROXY=%s' \
  "$PROXY_URL" "$PROXY_URL" "$PROXY_URL" "$PROXY_URL" "$NO_PROXY_VALUE" "$NO_PROXY_VALUE")
if [[ "$got_envs" == "$want" ]]; then
  pass "本机档：切号给 reclaude 的环境里带上登记的代理（大小写各一份，no_proxy 只放本机回环）"
else
  flunk "本机档带的代理不对：实际「$(tr '\n' ' ' <<<"$got_envs")」，应为「$(tr '\n' ' ' <<<"$want")」"
fi
if [[ "$(last_env)" == *"caller-env.invalid"* ]]; then
  flunk "调用者环境里的代理漏进了 reclaude 的环境：「$(last_env | tr '\n' ' ')」"
else
  pass "本机档：调用者环境里的代理没漏进去（用的是期望里登记的那个）"
fi

# 【故意造出的失败】登记的代理认不出（格式不对，复用 #763 的校验：只认 http://主机:端口）：读不出就不带。
# 不动仓里的期望文件：照本机档那份写一份到临时文件、只把这一项改坏，叫脚本用的那一段读它（直接设 SESSION_PROXY_DESIRED；
# 要在 source 之后设，profile.sh 开头会把这一项清成空）
bad=$TMP/bad-desired.json
if node -e '
  const fs = require("node:fs");
  const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  j.files["engine.env"].FLEET_SESSION_PROXY.value = "http://user:fakesecret@127.0.0.1:7890";
  fs.writeFileSync(process.argv[2], JSON.stringify(j));' "$HERE/../local/desired-config.json" "$bad" 2>/dev/null; then
  got=$(AGENT_SCOPE_DEPLOY=$HERE/.. BAD=$bad bash -c '
    source "$AGENT_SCOPE_DEPLOY/lib/profile.sh"
    PROFILE=local
    SESSION_PROXY_DEPLOY=$AGENT_SCOPE_DEPLOY
    SESSION_PROXY_DESIRED=$BAD
    if session_proxy_load; then echo "带上了：$SESSION_PROXY"; else echo "没读成：$SESSION_PROXY_WHY"; fi' 2>&1)
  if [[ "$got" == 没读成* ]]; then
    pass "【故意造出的失败】登记的代理格式不对（带账号密码）：读不出，不拿直连顶"
  else
    flunk "登记的代理格式不对该读不出：实际「$got」"
  fi
  # 读不出时给 reclaude 的环境里一个代理变量都不带（read_proxy 里就是这么接的：读不着就留空）
  got2=$(AGENT_SCOPE_DEPLOY=$HERE/.. BAD=$bad bash -c '
    source "$AGENT_SCOPE_DEPLOY/lib/profile.sh"
    PROFILE=local
    SESSION_PROXY_DEPLOY=$AGENT_SCOPE_DEPLOY
    SESSION_PROXY_DESIRED=$BAD
    if session_proxy_load; then vars=("${SESSION_PROXY_VARS[@]}"); else vars=(); fi
    echo "${#vars[@]}"' 2>/dev/null)
  if [[ "$got2" == 0 ]]; then
    pass "登记的代理认不出：要带给 reclaude 的变量是空的（不拿直连顶）"
  else
    flunk "登记的代理认不出还是带了 $got2 项代理变量"
  fi
else
  echo "  … 没跑成：这台没有 node，登记的代理认不出那一条没测"
  skipped=1
fi
unset https_proxy http_proxy FLEET_SESSION_PROXY
rm -f -- "$TMP/profile"

if ((fail)); then
  echo "org-use：不通过"
  exit 1
fi
if ((skipped)); then
  echo "org-use：其余通过，有没跑成的（见上）"
  exit 2
fi
echo "org-use：通过"
