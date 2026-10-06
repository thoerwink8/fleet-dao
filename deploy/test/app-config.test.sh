#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 应用的本机配置里装机脚本要管的几件事（deploy/lib/app-config.sh），拿临时文件走一遍：
#   0. 读键和 systemd 同一种读法：缩进、= 两边的空白、引号、转义、注释、CRLF、同一个键写几行取最后一行，逐条造出来比
#   1. 新机器照仓里的期望建三份环境文件（#323，env_from_desired，拿仓里法国那份真的期望）：公开的照期望写、私有的
#      只留空位、属主权限对；文件已经在不建不补（第二遍零改动）；期望读不到、认不出判红、不建
#   2. api.env 的 FLEET_GITHUB_WEBHOOK_SECRET：空着才照「引擎」App 的 json 填，第二遍零改动；json 没有、不是 JSON、
#      值的样子写不进环境文件、这一行被注释掉，都记待配、文件不动；同一个键写了两行判红、不改；读回两边不一致判红；
#      值从头到尾不进输出
#   3. 功能删掉了、键还留在环境文件里：装机脚本删掉那一行（生效的、被注释掉的都算）；没有这个键什么都不做；
#      读不到、认不出判红；第二遍零改动
#   4. 读回引擎的 engine.env：端口实现（要人定）、工作树的根和引擎状态目录钉在约定值上
#   5. 每一种读不到（文件不在、是个目录）、认不出（引号没配上）：判红、返回非 0、文件没动
#   6. 读回要退役的垫片：在记待配，不在通过
#   7. 读回环境文件的属主权限：不是 640（组读不到、谁都能读）、不在、是符号链接，判红
#   8. 读回整份环境文件里写了几行的键：任一个都判红、只报键名；文件不在判红
#   9. 配置文件的路径是目录、符号链接、断链：判红、背后的东西不动；france.sh 改之前都先判
# 要 root（put_file 要改属主）。用法：sudo bash deploy/test/app-config.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/app-config.sh
source "$HERE/../lib/app-config.sh"

if ((EUID != 0)); then
  echo "没跑成：要 root（写文件要改属主）"
  exit 2
fi
APP_CONFIG_NODE=$(command -v node) || {
  echo "没跑成：这台没有 node"
  exit 2
}
APP_CONFIG_OWNER=root:root

T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
fail=0
pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}
# 清空结论账：看这一次记了几处改动、几项待配、几项红
reset() {
  CHANGES=()
  PENDING=()
  REDS=()
}
# 调一个会记账的函数。不放进 $(…)：子 shell 里记的红、待配带不回来。输出在 OUT，返回码在 RC
call() {
  reset
  RC=0
  "$@" >"$T/out" 2>&1 || RC=$?
  OUT=$(<"$T/out")
}
# 文件的指纹：不在、是目录也各有说法，用来断言「没动」
digest() {
  if [[ -d "$1" ]]; then
    echo "目录"
  elif [[ -e "$1" ]]; then
    sha256sum <"$1"
  else
    echo "不在"
  fi
}
# 判红、返回非 0、文件没动（读不到、认不出那几类的共同要求）
expect_red_untouched() { # 说明 文件 之前的指纹
  if ((RC != 0 && ${#REDS[@]} >= 1 && ${#CHANGES[@]} == 0)) && [[ "$(digest "$2")" == "$3" ]]; then
    pass "$1：判红、返回 $RC、文件没动"
  else
    flunk "$1：该判红、返回非 0、文件不动（返回 $RC，红 ${#REDS[@]}，改动 ${#CHANGES[@]}）：$OUT"
  fi
}

echo "== 读键和 systemd 同一种读法"
parse_case() { # 说明 期望的值（<没有> = 一次都没赋值） 期望赋了几次 文件内容
  local what=$1 want=$2 count=$3 rc=0
  printf '%s' "$4" >"$T/p.env"
  env_get "$T/p.env" K || rc=$?
  if [[ "$want" == '<没有>' ]]; then
    if ((rc == 1)); then pass "$what：没有生效的 K"; else flunk "$what：该是没有生效的 K（返回 $rc，读成「$APP_ENV_VALUE」）"; fi
    return 0
  fi
  if ((rc == 0 && APP_ENV_COUNT == count)) && [[ "$APP_ENV_VALUE" == "$want" ]]; then
    pass "$what：「$want」"
  else
    flunk "$what：该是「$want」、$count 次，读成「$APP_ENV_VALUE」、$APP_ENV_COUNT 次（返回 $rc）"
  fi
}
parse_case '行首缩进' abc 1 '  K=abc'
parse_case '= 两边的空白、行尾空白' abc 1 'K = abc  '
parse_case '双引号去一层' 'a b' 1 'K="a b"'
parse_case '单引号去一层，里面原样' 'a"b' 1 "K='a\"b'"
# shellcheck disable=SC2016 # 就是要字面上的反斜杠和 $：这一条比的就是它们怎么被读
parse_case '双引号里 \" \\ \$ 去掉反斜杠' 'a"b\c$d' 1 'K="a\"b\\c\$d"'
parse_case '双引号里别的反斜杠照留' 'a\nb' 1 'K="a\nb"'
parse_case '不带引号：反斜杠留下后一个字符' 'a b' 1 'K=a\ b'
parse_case '值里的 # 不是注释' 'a#b' 1 'K=a#b'
parse_case '; 开头的行是注释' y 1 $'; K=x\nK=y'
parse_case 'CRLF 换行' abc 1 $'K=abc\r\n'
parse_case '同一个键写两行：生效的是后一行' second 2 $'K=first\nK=second'
parse_case '引号前后几段拼成一个值' ab 1 'K="a" "b"'
parse_case '空值' '' 1 'K='
parse_case '双引号可以跨行' $'l1\nl2' 1 $'K="l1\nl2"'
parse_case '光写了键、没写 =' '<没有>' 0 'K'
parse_case '注释掉的赋值' '<没有>' 0 '# K=abc'
parse_case '键名里有空白：整条不算' '<没有>' 0 'K X=1'
printf 'A=1\nK="abc\nB=2\n' >"$T/p.env"
if ! env_parse "$T/p.env" && [[ "$APP_CONFIG_WHY" == *引号* ]]; then
  pass "引号到文件末尾都没配上：认不出（$APP_CONFIG_WHY）"
else
  flunk "引号没配上该认不出：返回 0，原因「$APP_CONFIG_WHY」"
fi

echo "== 新机器照仓里的期望建环境文件（#323）"
REPO=$(cd -- "$HERE/../.." && pwd)
CLI=$REPO/deploy/france/auto-release/config.mjs
FRANCE_DESIRED=$REPO/deploy/france/desired-config.json
for name in engine api release; do
  call env_from_desired "$T/fr-$name.env" "$name.env" "$FRANCE_DESIRED" "$CLI"
  if ((RC == 0 && ${#REDS[@]} == 0 && ${#CHANGES[@]} == 1)) && [[ "$(stat -c '%U:%G %a' "$T/fr-$name.env")" == "$APP_CONFIG_OWNER 640" ]]; then
    pass "$name.env：照法国的期望建出来，$APP_CONFIG_OWNER 640"
  else
    flunk "$name.env 该照期望建出来（返回 $RC，红 ${#REDS[@]}，改动 ${#CHANGES[@]}）：$OUT"
  fi
done
expect_value() { # 文件 键 期望的值 说明：按 systemd 的读法读回来，恰好一行、值对
  local rc=0
  env_get "$1" "$2" || rc=$?
  if ((rc == 0 && APP_ENV_COUNT == 1)) && [[ "$APP_ENV_VALUE" == "$3" ]]; then
    pass "$4"
  else
    flunk "$4：读成「$APP_ENV_VALUE」（返回 $rc，$APP_ENV_COUNT 行）"
  fi
}
expect_value "$T/fr-engine.env" FLEET_ENGINE_PORTS real "engine.env 的端口实现照期望写（期望就是人定的那一份）"
expect_value "$T/fr-engine.env" FLEET_WORK_DIR /var/lib/fleet-work "engine.env 的工作树的根照期望写"
expect_value "$T/fr-api.env" FLEET_ENV production "api.env 的公开值照期望写"
expect_value "$T/fr-engine.env" FLEET_CANARY_REPO thoerwink8/fleet-dao-canary-fr "巡检仓（公开值，照期望写）"
expect_value "$T/fr-api.env" FLEET_GITHUB_WEBHOOK_SECRET "" "webhook 密钥（私有值）只留空位"
expect_value "$T/fr-api.env" FEISHU_APP_SECRET "" "飞书密钥（私有值）只留空位"
expect_value "$T/fr-release.env" FLEET_DOMAIN "" "域名（私有值）只留空位"
# 空着的 webhook 密钥那一行，填密钥照样认得（新机器上紧接着就要填）
printf '{"webhook_secret": "0123456789abcdef0123456789abcdef01234567"}\n' >"$T/new-app.json"
call fill_webhook_secret "$T/fr-api.env" "$T/new-app.json"
expect_value "$T/fr-api.env" FLEET_GITHUB_WEBHOOK_SECRET 0123456789abcdef0123456789abcdef01234567 "照期望建出来的 api.env：空着的 webhook 密钥照「引擎」App 填上"
before=$(digest "$T/fr-engine.env")
call env_from_desired "$T/fr-engine.env" engine.env "$FRANCE_DESIRED" "$CLI"
if ((RC == 0 && ${#CHANGES[@]} == 0)) && [[ "$(digest "$T/fr-engine.env")" == "$before" && -z "$OUT" ]]; then
  pass "文件已经在：不建不补，第二遍零改动"
else
  flunk "文件已经在却动了：$OUT"
fi
printf 'FLEET_MACHINE_NAME=别处\n' >"$T/hand.env"
before=$(digest "$T/hand.env")
call env_from_desired "$T/hand.env" engine.env "$FRANCE_DESIRED" "$CLI"
if ((RC == 0 && ${#CHANGES[@]} == 0)) && [[ "$(digest "$T/hand.env")" == "$before" ]]; then
  pass "人改过的文件不动、不补键（之后归发布时照期望写，对账报偏离）"
else
  flunk "人改过的文件被动了：$OUT"
fi
call env_from_desired "$T/new1.env" engine.env "$T/no-such-desired.json" "$CLI"
expect_red_untouched "期望读不到：不建" "$T/new1.env" "不在"
printf '{' >"$T/broken-desired.json"
call env_from_desired "$T/new2.env" engine.env "$T/broken-desired.json" "$CLI"
expect_red_untouched "期望认不出：不建（不拿空文件顶）" "$T/new2.env" "不在"
call env_from_desired "$T/new3.env" france.env "$FRANCE_DESIRED" "$CLI"
expect_red_untouched "不归它建的文件（france.env）：不建" "$T/new3.env" "不在"
mkdir "$T/dir.env" # 后面几段拿它当「是个目录、读不了」用

echo "== webhook 密钥"
SECRET=0123456789abcdef0123456789abcdef01234567
printf '{"id": 1, "webhook_secret": "%s", "pem": "x"}\n' "$SECRET" >"$T/engine-app.json"
printf 'FLEET_ENV=production\nFLEET_GITHUB_WEBHOOK_SECRET=\nFEISHU_APP_ID=cli_x\n' >"$T/api.env"
call fill_webhook_secret "$T/api.env" "$T/engine-app.json"
if ((RC == 0)) && [[ "$(env_value "$T/api.env" FLEET_GITHUB_WEBHOOK_SECRET)" == "$SECRET" && "$(env_value "$T/api.env" FEISHU_APP_ID)" == cli_x &&
  "$(grep -c '^FLEET_GITHUB_WEBHOOK_SECRET=' "$T/api.env")" == 1 && "$(stat -c '%a' "$T/api.env")" == 640 ]]; then
  pass "空着的那一行照「引擎」App 的 webhook_secret 填上，别的行不动，640"
else
  flunk "没填对：$OUT"
fi
if [[ "$OUT" != *"$SECRET"* ]]; then pass "值没进输出"; else flunk "值进了输出"; fi
before=$(digest "$T/api.env")
call fill_webhook_secret "$T/api.env" "$T/engine-app.json"
if ((RC == 0 && ${#CHANGES[@]} == 0)) && [[ "$(digest "$T/api.env")" == "$before" && -z "$OUT" ]]; then
  pass "第二遍零改动"
else
  flunk "第二遍动了文件：$OUT"
fi

# GitHub 的 webhook secret 可以是任意字符：+ / = # ; 这类写进环境文件照原样读回，要照填，不能当成「样子不对」
ODD='aB3+/=x#y;z%&*()!@^_{}[]|<>?,.~-9'
printf '{"webhook_secret": "%s"}\n' "$ODD" >"$T/odd-app.json"
printf 'FLEET_GITHUB_WEBHOOK_SECRET=\n' >"$T/api-odd.env"
call fill_webhook_secret "$T/api-odd.env" "$T/odd-app.json"
if ((RC == 0 && ${#CHANGES[@]} > 0 && ${#PENDING[@]} == 0)) && [[ "$(env_value "$T/api-odd.env" FLEET_GITHUB_WEBHOOK_SECRET)" == "$ODD" && "$OUT" != *"$ODD"* ]]; then
  pass "带 + / = # ; 的密钥照填，按 systemd 的读法读回和 json 里一字不差"
else
  flunk "带 + / = 的密钥该照填、读回一字不差（返回 $RC，改动 ${#CHANGES[@]}，待配 ${#PENDING[@]}）"
fi
call check_webhook_secret "$T/api-odd.env" "$T/odd-app.json"
if ((RC == 0 && ${#REDS[@]} == 0 && ${#PENDING[@]} == 0)); then
  pass "带 + / = 的密钥读回两边一致"
else
  flunk "带 + / = 的密钥读回该一致：$RC"
fi

call check_webhook_secret "$T/api.env" "$T/engine-app.json"
if ((RC == 0 && ${#REDS[@]} == 0 && ${#PENDING[@]} == 0)) && [[ "$OUT" == *"✓"* && "$OUT" != *"$SECRET"* ]]; then
  pass "读回：两边一致，通过（值不打印）"
else
  flunk "读回该通过（返回 $RC，红 ${#REDS[@]}，待配 ${#PENDING[@]}）：$OUT"
fi

printf 'FLEET_GITHUB_WEBHOOK_SECRET=someone-changed-it-by-hand\n' >"$T/api-other.env"
call check_webhook_secret "$T/api-other.env" "$T/engine-app.json"
if ((RC != 0 && ${#REDS[@]} == 1)) && [[ "$OUT" == *"不一致"* && "$OUT" != *"$SECRET"* && "$OUT" != *someone-changed* ]]; then
  pass "读回：两边不一致判红、返回非 0（两边的值都不打印）"
else
  flunk "不一致没判红：$OUT"
fi
call fill_webhook_secret "$T/api-other.env" "$T/engine-app.json"
if [[ "$(env_value "$T/api-other.env" FLEET_GITHUB_WEBHOOK_SECRET)" == someone-changed-it-by-hand ]]; then
  pass "已有值的不动（人改过的算数）"
else
  flunk "把人填的值盖掉了"
fi

printf 'FLEET_ENV=production\n' >"$T/api-noline.env"
call fill_webhook_secret "$T/api-noline.env" "$T/engine-app.json"
if [[ "$(env_value "$T/api-noline.env" FLEET_GITHUB_WEBHOOK_SECRET)" == "$SECRET" ]]; then
  pass "文件里连这一行都没有：补在末尾"
else
  flunk "没有这一行时没补上"
fi

printf 'FLEET_ENV=production\n  FLEET_GITHUB_WEBHOOK_SECRET = ""\n' >"$T/api-styled.env"
call fill_webhook_secret "$T/api-styled.env" "$T/engine-app.json"
styled_rc=$RC
# 不放进 $(…)：要在这里读 APP_ENV_COUNT
env_get "$T/api-styled.env" FLEET_GITHUB_WEBHOOK_SECRET
if ((styled_rc == 0 && APP_ENV_COUNT == 1)) && [[ "$APP_ENV_VALUE" == "$SECRET" ]]; then
  pass "缩进、= 两边有空白、值是一对空引号：那一行照样填上，还是一行"
else
  flunk "换了写法的空行没填对：$OUT"
fi

# 同一个键写了两行：systemd 取后一行。前空后有（人填的在后）和前有后空（生效的其实是空）都判红、不改，不能读回说一致
printf 'FLEET_GITHUB_WEBHOOK_SECRET=\nFLEET_GITHUB_WEBHOOK_SECRET=typed-by-a-human-later\n' >"$T/api-dup1.env"
if [[ "$(env_value "$T/api-dup1.env" FLEET_GITHUB_WEBHOOK_SECRET)" == typed-by-a-human-later ]]; then
  pass "前空后有：生效的是后一行（和 systemd 一样）"
else
  flunk "前空后有：该读成后一行"
fi
before=$(digest "$T/api-dup1.env")
call fill_webhook_secret "$T/api-dup1.env" "$T/engine-app.json"
expect_red_untouched "前空后有：不往前一行里写密钥" "$T/api-dup1.env" "$before"
call check_webhook_secret "$T/api-dup1.env" "$T/engine-app.json"
if ((RC != 0 && ${#REDS[@]} == 1)) && [[ "$OUT" != *"一致（"* && "$OUT" != *typed-by* ]]; then
  pass "前空后有：读回判红（写了两行），不说一致"
else
  flunk "前空后有：读回该判红：$OUT"
fi
printf 'FLEET_GITHUB_WEBHOOK_SECRET=%s\nFLEET_GITHUB_WEBHOOK_SECRET=\n' "$SECRET" >"$T/api-dup2.env"
if [[ -z "$(env_value "$T/api-dup2.env" FLEET_GITHUB_WEBHOOK_SECRET)" ]]; then
  pass "前有后空：生效的是空的那一行"
else
  flunk "前有后空：该读成空"
fi
call check_webhook_secret "$T/api-dup2.env" "$T/engine-app.json"
if ((RC != 0 && ${#REDS[@]} == 1)) && [[ "$OUT" != *"一致（"* && "$OUT" != *"$SECRET"* ]]; then
  pass "前有后空：读回判红（写了两行），不说一致"
else
  flunk "前有后空：读回该判红：$OUT"
fi
before=$(digest "$T/api-dup2.env")
call fill_webhook_secret "$T/api-dup2.env" "$T/engine-app.json"
expect_red_untouched "前有后空：不猜该改哪一行" "$T/api-dup2.env" "$before"

printf 'FLEET_ENV=production\n# FLEET_GITHUB_WEBHOOK_SECRET=\n' >"$T/api-commented.env"
before=$(digest "$T/api-commented.env")
call fill_webhook_secret "$T/api-commented.env" "$T/engine-app.json"
if ((RC == 0 && ${#PENDING[@]} == 1 && ${#CHANGES[@]} == 0)) && [[ "$(digest "$T/api-commented.env")" == "$before" ]]; then
  pass "被注释掉了：记待配，不替人放开"
else
  flunk "注释掉的 webhook 密钥该记待配、不动（返回 $RC，待配 ${#PENDING[@]}，改动 ${#CHANGES[@]}）：$OUT"
fi

for bad in missing notjson nosecret badchars; do
  printf 'FLEET_GITHUB_WEBHOOK_SECRET=\n' >"$T/api-$bad.env"
  case $bad in
  missing) json=$T/no-such.json ;;
  notjson)
    json=$T/notjson.json
    printf 'not json' >"$json"
    ;;
  nosecret)
    json=$T/nosecret.json
    printf '{"id": 1}' >"$json"
    ;;
  badchars)
    json=$T/badchars.json
    # shellcheck disable=SC2016 # 就是要一个字面上的 $：环境文件里的 $ 会被 systemd 当成变量展开
    printf '{"webhook_secret": "has space and $dollar"}' >"$json"
    ;;
  esac
  before=$(digest "$T/api-$bad.env")
  call fill_webhook_secret "$T/api-$bad.env" "$json"
  if ((${#PENDING[@]} == 1 && ${#CHANGES[@]} == 0)) && [[ "$(digest "$T/api-$bad.env")" == "$before" ]]; then
    pass "json $bad：记待配，文件不动（不瞎填）"
  else
    flunk "json $bad：该记待配、不动文件（待配 ${#PENDING[@]}，改动 ${#CHANGES[@]}）"
  fi
done

call fill_webhook_secret "$T/api-absent.env" "$T/engine-app.json"
expect_red_untouched "api.env 不在：不新建一份只有密钥的" "$T/api-absent.env" "不在"
call fill_webhook_secret "$T/dir.env" "$T/engine-app.json"
expect_red_untouched "api.env 是个目录（读不了）" "$T/dir.env" "目录"
call check_webhook_secret "$T/api-absent.env" "$T/engine-app.json"
if ((RC != 0 && ${#REDS[@]} == 1)) && [[ "$OUT" == *"没有"* ]]; then
  pass "读回：api.env 不在，判红、返回非 0"
else
  flunk "读回：api.env 不在该判红：$OUT"
fi

echo "== 删掉不再用的键（remove_stale_key）"
VALUE=fake-org-778899
printf 'FLEET_ENGINE_PORTS=real\nFLEET_SENSITIVE_VALUES_FILE=%s\nFLEET_WORK_DIR=/var/lib/fleet-work\n' \
  "$VALUE" >"$T/stale-active.env"
chmod 640 "$T/stale-active.env"
call remove_stale_key "$T/stale-active.env" FLEET_SENSITIVE_VALUES_FILE "机制删掉了"
if ((RC == 0 && ${#CHANGES[@]} > 0 && ${#REDS[@]} == 0)) \
  && [[ "$OUT" != *"$VALUE"* ]] \
  && [[ "$(env_value "$T/stale-active.env" FLEET_SENSITIVE_VALUES_FILE 2>/dev/null)" == "" ]] \
  && [[ "$(env_value "$T/stale-active.env" FLEET_ENGINE_PORTS)" == real ]] \
  && [[ "$(env_value "$T/stale-active.env" FLEET_WORK_DIR)" == /var/lib/fleet-work ]]; then
  pass "生效的赋值：删掉那一行，旁的键不动，值不打印"
else
  flunk "该删掉生效的赋值、留着旁的键：$OUT"
fi

printf 'FLEET_ENGINE_PORTS=real\n# FLEET_SENSITIVE_VALUES_FILE=%s\nFLEET_WORK_DIR=/var/lib/fleet-work\n' \
  "$VALUE" >"$T/stale-commented.env"
chmod 640 "$T/stale-commented.env"
call remove_stale_key "$T/stale-commented.env" FLEET_SENSITIVE_VALUES_FILE "机制删掉了"
env_parse "$T/stale-commented.env" # 重新读一遍改过的文件，env_mentioned 才是删除之后的状态
if ((RC == 0 && ${#CHANGES[@]} > 0)) && ! env_mentioned FLEET_SENSITIVE_VALUES_FILE; then
  pass "被注释掉的也删：不留死配置"
else
  flunk "该把注释掉的那一行也删掉：$OUT"
fi

printf 'FLEET_ENGINE_PORTS=real\nFLEET_WORK_DIR=/var/lib/fleet-work\n' >"$T/no-stale.env"
chmod 640 "$T/no-stale.env"
before=$(digest "$T/no-stale.env")
call remove_stale_key "$T/no-stale.env" FLEET_SENSITIVE_VALUES_FILE "机制删掉了"
if ((RC == 0 && ${#CHANGES[@]} == 0 && ${#REDS[@]} == 0)) && [[ "$(digest "$T/no-stale.env")" == "$before" ]]; then
  pass "没有这个键：什么都不做，第二遍零改动"
else
  flunk "没有这个键不该动文件：$OUT"
fi

call remove_stale_key "$T/no-such-stale.env" FLEET_SENSITIVE_VALUES_FILE "机制删掉了"
expect_red_untouched "文件不在" "$T/no-such-stale.env" "不在"
call remove_stale_key "$T/dir.env" FLEET_SENSITIVE_VALUES_FILE "机制删掉了"
expect_red_untouched "文件是个目录" "$T/dir.env" "目录"

echo "== 引擎的 engine.env"
WORK=/var/lib/fleet-work
STATE=/var/lib/fleet-dao/engine
# 工作树的根、引擎状态目录钉对了的两行：前面的用例只看端口，都带上它们；看这两个键的用例把 TAIL 换掉
PINS="FLEET_WORK_DIR=$WORK
FLEET_ENGINE_STATE_DIR=$STATE"
TAIL=$PINS
engine_case() { # 说明 期望（ok / pending / red） 文件内容 [输出里要有的字]
  local what=$1 want=$2 words=${4:-} got=ok rc_ok=0
  printf '%s\n%s\n' "$3" "$TAIL" >"$T/check-engine.env"
  call check_engine_env "$T/check-engine.env" "$WORK" "$STATE"
  if ((${#REDS[@]})); then
    got=red
  elif ((${#PENDING[@]})); then
    got=pending
  fi
  # 判红返回非 0，待配、通过返回 0
  if [[ "$want" == red ]]; then
    if ((RC != 0)); then rc_ok=1; fi
  elif ((RC == 0)); then
    rc_ok=1
  fi
  if ((rc_ok)) && [[ "$got" == "$want" && "$OUT" == *"$words"* ]]; then
    pass "$what：$want（返回 $RC）"
  else
    flunk "$what：该是 $want，实际 $got、返回 $RC：$OUT"
  fi
}
engine_case '真端口' ok 'FLEET_ENGINE_PORTS=real'
engine_case '值带引号（去一层）' ok 'FLEET_ENGINE_PORTS="real"'
engine_case '假端口' pending 'FLEET_ENGINE_PORTS=fake' 'fake'
engine_case 'real 在前、fake 在后：生效的是 fake，写了两行判红' red "FLEET_ENGINE_PORTS=real
FLEET_ENGINE_PORTS=fake" '「fake」'
engine_case '缩进、KEY = 值照样认' pending '   FLEET_ENGINE_PORTS = fake' 'fake'
engine_case '没写端口实现（要人定）' red '' 'FLEET_ENGINE_PORTS'
engine_case '端口实现被注释掉' red '# FLEET_ENGINE_PORTS=real' '注释'
engine_case '端口实现不认识' red 'FLEET_ENGINE_PORTS=maybe' '「maybe」'
# 发布只写期望变了的键、人手改的不改回：机器上留着的旧值只有读回拦得住
TAIL="FLEET_ENGINE_STATE_DIR=$STATE"
engine_case '工作树的根是旧值 /tmp' red "FLEET_ENGINE_PORTS=real
FLEET_WORK_DIR=/tmp" '「/tmp」'
engine_case '没写工作树的根' pending 'FLEET_ENGINE_PORTS=real' 'FLEET_WORK_DIR'
engine_case '工作树的根写了两行' red "FLEET_ENGINE_PORTS=real
FLEET_WORK_DIR=$WORK
FLEET_WORK_DIR=/tmp" '写了 2 行'
TAIL="FLEET_WORK_DIR=$WORK"
engine_case '引擎状态目录不对' red "FLEET_ENGINE_PORTS=real
FLEET_ENGINE_STATE_DIR=/var/tmp/engine" '「/var/tmp/engine」'
engine_case '引擎状态目录被注释掉' pending "FLEET_ENGINE_PORTS=real
# FLEET_ENGINE_STATE_DIR=$STATE" '注释'
TAIL=$PINS

call check_engine_env "$T/no-such-engine.env" "$WORK" "$STATE"
missing_out=$OUT
expect_red_untouched "engine.env 不在" "$T/no-such-engine.env" "不在"
call check_engine_env "$T/dir.env" "$WORK" "$STATE"
dir_out=$OUT
expect_red_untouched "engine.env 是个目录" "$T/dir.env" "目录"
printf 'FLEET_ENGINE_PORTS="real\n' >"$T/openquote-engine.env"
before=$(digest "$T/openquote-engine.env")
call check_engine_env "$T/openquote-engine.env" "$WORK" "$STATE"
open_out=$OUT
expect_red_untouched "engine.env 引号没配上" "$T/openquote-engine.env" "$before"
if [[ "$missing_out" == *"没有"* && "$dir_out" == *"读不了"* && "$open_out" == *"认不出"* ]]; then
  pass "不在、读不了、认不出各报各的"
else
  flunk "读不到和认不出混成了一句：$missing_out / $dir_out / $open_out"
fi

echo "== 环境文件的属主权限"
for n in m1 m2; do
  printf 'X=1\n' >"$T/$n.env"
  chown root:root "$T/$n.env"
  chmod 640 "$T/$n.env"
done
call check_app_file_meta "$T/m1.env" "$T/m2.env"
if ((RC == 0 && ${#REDS[@]} == 0)); then pass "都是 640：通过"; else flunk "都是 640 该通过：$OUT"; fi
meta_case() { # 说明 怎么弄坏 m2（600 / 644 / missing / symlink）
  printf 'X=1\n' >"$T/m2.env"
  chmod 640 "$T/m2.env"
  case $2 in
  600 | 644) chmod "$2" "$T/m2.env" ;;
  missing) rm -f "$T/m2.env" ;;
  symlink) rm -f "$T/m2.env" && ln -s "$T/m1.env" "$T/m2.env" ;;
  esac
  call check_app_file_meta "$T/m1.env" "$T/m2.env"
  if ((RC != 0 && ${#REDS[@]} == 1)); then pass "$1：判红、返回非 0"; else flunk "$1：该判红（返回 $RC，红 ${#REDS[@]}）：$OUT"; fi
}
meta_case '组读不到（600，root 读回照样读得到、服务读不到）' 600
meta_case '谁都能读（644）' 644
meta_case '不在' missing
meta_case '是符号链接' symlink
rm -f "$T/m2.env"

echo "== 整份文件里写了几行的键"
printf 'TEMPORAL_ADDRESS=127.0.0.1:7243\nFLEET_ENV=production\n' >"$T/dup-ok.env"
printf 'FLEET_SERVICES=fleet-api\nX=1\n  FLEET_SERVICES = dup-value-secret\n' >"$T/dup-bad.env"
call check_env_duplicates "$T/dup-ok.env"
if ((RC == 0 && ${#REDS[@]} == 0)); then pass "没有写两行的键：通过"; else flunk "干净的文件该通过：$OUT"; fi
call check_env_duplicates "$T/dup-ok.env" "$T/dup-bad.env"
if ((RC != 0 && ${#REDS[@]} == 1)) && [[ "$OUT" == *"FLEET_SERVICES"* && "$OUT" != *"dup-value-secret"* ]]; then
  pass "任一个键写了两行（缩进、KEY = 值也算）：判红、点名键、不打印值"
else
  flunk "写了两行的键该判红：$OUT"
fi
call check_env_duplicates "$T/no-such-dup.env"
if ((RC != 0 && ${#REDS[@]} == 1)); then pass "文件不在：判红"; else flunk "文件不在该判红：$OUT"; fi

echo "== 照期望建出来的 engine.env 读回：端口实现、工作树的根、引擎状态目录都对"
call check_engine_env "$T/fr-engine.env" "$WORK" "$STATE"
if ((RC == 0 && ${#REDS[@]} == 0 && ${#PENDING[@]} == 0)); then
  pass "照法国的期望建出来的 engine.env：读回全过"
else
  flunk "照期望建出来的 engine.env 读回该全过（返回 $RC，红 ${#REDS[@]}，待配 ${#PENDING[@]}）：$OUT"
fi

echo "== 配置文件的路径不是普通文件：判红、什么都不改"
printf 'X=1\n' >"$T/target.env"
chmod 600 "$T/target.env"
target_before="$(digest "$T/target.env") $(stat -c '%U:%G %a' "$T/target.env")"
mkdir -p "$T/is-dir.env"
ln -s "$T/target.env" "$T/link.env"
ln -s "$T/gone.env" "$T/broken.env"
for bad in is-dir link broken; do
  call app_config_path_ok "$T/$bad.env"
  if ((RC != 0 && ${#REDS[@]} == 1)); then pass "$bad：判红、返回非 0"; else flunk "$bad：该判红（返回 $RC）：$OUT"; fi
done
if [[ "$(digest "$T/target.env") $(stat -c '%U:%G %a' "$T/target.env")" == "$target_before" && ! -e "$T/gone.env" && -d "$T/is-dir.env" ]]; then
  pass "链接指的文件、断链指的地方、目录都没被动"
else
  flunk "坏路径背后的东西被动了"
fi
call app_config_path_ok "$T/target.env"
ok_file=$RC
call app_config_path_ok "$T/not-yet.env"
if ((ok_file == 0 && RC == 0 && ${#REDS[@]} == 0)); then pass "普通文件、还不在（第一次建）：可以动"; else flunk "普通文件、还不在该可以动"; fi
# france.sh 的两个循环都先过这一关，再 fix_meta、put_file（改之前必须先判路径）
setup_body=$(sed -n '/^setup_app_config() {/,/^}/p' "$HERE/../france.sh")
# shellcheck disable=SC2016 # 找的就是字面上的 $file
if [[ "$(grep -c 'app_config_path_ok "$file"' <<<"$setup_body")" == 2 && "$setup_body" == *'if ((api_ok)); then fill_webhook_secret'* ]]; then
  pass "france.sh 建环境文件和随机密钥之前都先判路径，api.env 坏了不填 webhook 密钥"
else
  flunk "france.sh 的 setup_app_config 没有在两个循环里先判路径"
fi
# shellcheck disable=SC2016 # 找的就是字面上的 $file、$desired
if [[ "$setup_body" == *'env_from_desired "$file" "$name.env" "$desired" "$CONFIG_CLI"'* &&
  "$setup_body" == *'desired=$DEPLOY_DIR/france/desired-config.json'* && "$setup_body" != *'.env.example'* &&
  "$setup_body" != *add_missing_keys* ]]; then
  pass "france.sh 新机器照法国的期望建环境文件，不照样例、不补键"
else
  flunk "france.sh 的 setup_app_config 该照法国的期望建（env_from_desired），不再照样例建、补键"
fi

echo "== 要退役的垫片"
printf '#!/bin/sh\n' >"$T/carpool-run.sh"
call check_retired "$T/carpool-run.sh" 派活垫片
if ((RC == 0 && ${#PENDING[@]} == 1 && ${#REDS[@]} == 0)); then pass "还在：记待配"; else flunk "垫片还在该记待配：$OUT"; fi
call check_retired "$T/gone.sh" 派活垫片
if ((RC == 0 && ${#PENDING[@]} == 0 && ${#REDS[@]} == 0)) && [[ "$OUT" == *"✓"* ]]; then
  pass "不在了：通过"
else
  flunk "垫片不在了该通过：$OUT"
fi

if ((fail)); then
  echo "不通过"
  exit 1
fi
echo "通过"
