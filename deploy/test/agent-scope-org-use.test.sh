#!/usr/bin/env bash
# fleet-agent-scope 的 org-use 子命令（#157：切会话用户挂的 reclaude 组织）。不要 root、不要真的会话用户：
# AGENT_SCOPE_TEST_AS_USER=direct 不降权直接跑，AGENT_SCOPE_TEST_HOME 给一个临时家目录，AGENT_SCOPE_TEST_RECLAUDE 换成假的
# reclaude（状态在那个家目录的 .fake-reclaude 下：挂着哪个、org use 这一下怎么表现）。每种没切成的路径都故意造一遍：
# org list 读不了、认不出、带 * 的不是恰好一行、那一类的组织不是恰好一个、org use 退出码 1 却切了（CC-07）、退出码 0 却没切、
# 切错了往回切、往回切也没成、切完回读核对不了；输出里一律搜不到组织编号和邮箱。
# 法国真机上以 root 经 setpriv 降成会话用户那一段由 deploy/test/agent-scope.e2e.sh 那一类真机演练看（#157 结果里记）。
# 用法：bash deploy/test/agent-scope-org-use.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BIN=$HERE/../france/fleet-agent-scope.sh
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
fail=0
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
FAKE=$TMP/fake-reclaude
cat >"$FAKE" <<'SH'
#!/usr/bin/env bash
S=$HOME/.fake-reclaude
echo "$*" >>"$S/calls"
if [[ "${1:-} ${2:-}" == "org list" ]]; then
  if [[ -f "$S/list-exit" ]]; then
    echo "boom: org 1111 of someone@example.com" >&2
    exit "$(cat "$S/list-exit")"
  fi
  if [[ -f "$S/list-fail-after-use" && -f "$S/used" ]]; then
    echo "dial tcp: connection refused" >&2
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
touch "$S/list-fail-after-use"
run carpool --user fleet-agent-carpool
expect "切完回读核对不了：不知道挂的是哪个，不往回切" 1 "failed unknown" "没敢往回切"
[[ "$(uses)" == 1 ]] || flunk "核对不了就不该往回切：org use $(uses) 次"

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
expect "切完回读卡住：到总时限就停，不知道挂的是哪个，不往回切" 1 "failed unknown" "超时被停"
((took <= 8)) || flunk "应在总时限 8 秒里收场：用了 $took 秒"
[[ "$(uses)" == 1 ]] || flunk "核对不了就不该往回切：org use $(uses) 次"
unset AGENT_SCOPE_TEST_ORG_BUDGET AGENT_SCOPE_TEST_ORG_RESERVE

if ((fail)); then
  echo "org-use：不通过"
  exit 1
fi
echo "org-use：通过"
