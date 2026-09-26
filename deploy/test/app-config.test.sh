#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 应用的本机配置里装机脚本要管的几件事（deploy/lib/app-config.sh），拿临时文件走一遍：
#   0. 读键和 systemd 同一种读法：缩进、= 两边的空白、引号、转义、注释、CRLF、同一个键写几行取最后一行，逐条造出来比
#   1. 样例后来加的键：只补缺、已有的值不动；缩进的、KEY = 值、注释掉的、光写了键都算出现过，不补；要人定的键不补；
#      第二遍零改动
#   2. api.env 的 FLEET_GITHUB_WEBHOOK_SECRET：空着才照「引擎」App 的 json 填，第二遍零改动；json 没有、不是 JSON、
#      值的样子写不进环境文件、这一行被注释掉，都记待配、文件不动；同一个键写了两行判红、不改；读回两边不一致判红；
#      值从头到尾不进输出
#   3. 读回已知敏感值名单：没有、只有注释记待配，谁都能读判红，好的通过；内容不进输出
#   4. 读回引擎的 engine.env：端口实现（要人定）、名单的路径（钉在读回核的那一份上）
#   5. 每一种读不到（文件不在、是个目录）、认不出（引号没配上、样例里有看不懂的行）：判红、返回非 0、文件没动
#   6. 读回要退役的垫片：在记待配，不在通过
#   7. 读回环境文件的属主权限：不是 640（组读不到、谁都能读）、不在、是符号链接，判红
#   8. 读回整份环境文件里写了几行的键：任一个都判红、只报键名；文件不在判红
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

echo "== 样例后来加的键"
printf '# 样例\nFLEET_ENGINE_PORTS=real\nDATABASE_URL=postgres:///fleet\nFLEET_MACHINE_NAME=法国\nFLEET_WORK_DIR=/var/lib/fleet-work\n' >"$T/engine.example"
printf 'FLEET_ENGINE_PORTS=fake\n# 人写的注释\nDATABASE_URL=postgres:///mine\n' >"$T/engine.env"
call add_missing_keys "$T/engine.env" "$T/engine.example"
if ((RC == 0)) && [[ "$(env_value "$T/engine.env" FLEET_ENGINE_PORTS)" == fake && "$(env_value "$T/engine.env" DATABASE_URL)" == postgres:///mine &&
  "$(env_value "$T/engine.env" FLEET_MACHINE_NAME)" == 法国 && "$(env_value "$T/engine.env" FLEET_WORK_DIR)" == /var/lib/fleet-work ]] &&
  grep -q '人写的注释' "$T/engine.env"; then
  pass "补上了缺的两个键，已有的值和注释都没动"
else
  flunk "补键不对：$(cat "$T/engine.env")"
fi
before=$(digest "$T/engine.env")
call add_missing_keys "$T/engine.env" "$T/engine.example"
if ((RC == 0 && ${#CHANGES[@]} == 0)) && [[ "$(digest "$T/engine.env")" == "$before" && -z "$OUT" ]]; then
  pass "第二遍零改动"
else
  flunk "第二遍动了文件：$OUT"
fi

# 人换了写法、注释掉、光写了键：都算出现过，不在末尾再补一行
printf '  FLEET_ENGINE_PORTS=fake\nDATABASE_URL = postgres:///mine\n# FLEET_WORK_DIR=/somewhere/else\nFLEET_MACHINE_NAME\n' >"$T/styled.env"
cp "$T/engine.example" "$T/styled.example"
printf 'FLEET_ENGINE_STATE_DIR=/var/lib/fleet-dao/engine\n' >>"$T/styled.example"
call add_missing_keys "$T/styled.env" "$T/styled.example"
if ((RC == 0)) && [[ "$(env_value "$T/styled.env" FLEET_ENGINE_PORTS)" == fake && "$(env_value "$T/styled.env" DATABASE_URL)" == postgres:///mine &&
  "$(env_value "$T/styled.env" FLEET_ENGINE_STATE_DIR)" == /var/lib/fleet-dao/engine ]] &&
  ! grep -q '^FLEET_ENGINE_PORTS=' "$T/styled.env" && ! grep -q '^DATABASE_URL=' "$T/styled.env" &&
  ! grep -q '^FLEET_WORK_DIR=' "$T/styled.env" && ! grep -q '^FLEET_MACHINE_NAME=' "$T/styled.env"; then
  pass "缩进的、KEY = 值、注释掉的、光写了键都算出现过：只补了真缺的那一个"
else
  flunk "换了写法的键被当成缺的补了：$(cat "$T/styled.env")"
fi
before=$(digest "$T/styled.env")
call add_missing_keys "$T/styled.env" "$T/styled.example"
if ((RC == 0 && ${#CHANGES[@]} == 0)) && [[ "$(digest "$T/styled.env")" == "$before" ]]; then
  pass "注释掉的键第二遍也不补回来"
else
  flunk "第二遍把注释掉的键补回来了：$OUT"
fi

printf 'DATABASE_URL=postgres:///mine\n' >"$T/noports.env"
call add_missing_keys "$T/noports.env" "$T/engine.example"
if ((RC == 0)) && [[ -z "$(env_value "$T/noports.env" FLEET_ENGINE_PORTS)" ]] && ! grep -q FLEET_ENGINE_PORTS "$T/noports.env"; then
  pass "FLEET_ENGINE_PORTS 要人定：样例里有也不补"
else
  flunk "替人补了 FLEET_ENGINE_PORTS：$(cat "$T/noports.env")"
fi

before=$(digest "$T/engine.env")
call add_missing_keys "$T/engine.env" "$T/no-such.example"
expect_red_untouched "样例读不到" "$T/engine.env" "$before"
call add_missing_keys "$T/no-such.env" "$T/engine.example"
expect_red_untouched "要补的文件不在（不新建）" "$T/no-such.env" "不在"
mkdir "$T/dir.env"
call add_missing_keys "$T/dir.env" "$T/engine.example"
expect_red_untouched "要补的文件是个目录（读不了）" "$T/dir.env" "目录"
printf 'FLEET_ENGINE_PORTS=fake\nFEISHU_APP_SECRET="abc\n' >"$T/openquote.env"
before=$(digest "$T/openquote.env")
call add_missing_keys "$T/openquote.env" "$T/engine.example"
expect_red_untouched "要补的文件引号没配上（认不出）" "$T/openquote.env" "$before"
printf 'FLEET_A=1\nexport FLEET_B=2\n' >"$T/odd.example"
before=$(digest "$T/engine.env")
call add_missing_keys "$T/engine.env" "$T/odd.example"
expect_red_untouched "样例里有看不懂的行" "$T/engine.env" "$before"

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

echo "== 已知敏感值名单"
VALUE=fake-org-778899
call check_sensitive_values "$T/no-such-values.txt"
if ((RC == 0 && ${#PENDING[@]} == 1 && ${#REDS[@]} == 0)); then pass "没有：记待配"; else flunk "没有该记待配：$OUT"; fi

printf '# 真值一行一个\n\n' >"$T/empty-values.txt"
chmod 640 "$T/empty-values.txt"
call check_sensitive_values "$T/empty-values.txt"
if ((RC == 0 && ${#PENDING[@]} == 1 && ${#REDS[@]} == 0)); then
  pass "只有注释、空行：记待配（卫生检查按没读到处理）"
else
  flunk "空的该记待配：$OUT"
fi

printf '%s\n' "$VALUE" >"$T/open-values.txt"
chmod 644 "$T/open-values.txt"
call check_sensitive_values "$T/open-values.txt"
if ((RC != 0 && ${#REDS[@]} == 1)) && [[ "$OUT" != *"$VALUE"* ]]; then
  pass "谁都能读（644）：判红、返回非 0，值不打印"
else
  flunk "644 该判红：$OUT"
fi

printf '# 注释\n  %s\n' "$VALUE" >"$T/values.txt"
chmod 640 "$T/values.txt"
call check_sensitive_values "$T/values.txt"
if ((RC == 0 && ${#REDS[@]} == 0 && ${#PENDING[@]} == 0)) && [[ "$OUT" == *"有值"* && "$OUT" != *"$VALUE"* ]]; then
  pass "在、640、有值：通过，内容不打印"
else
  flunk "好的名单没认出来：$OUT"
fi

echo "== 引擎的 engine.env"
LIST=/etc/fleet-dao/sensitive-values.txt
WORK=/var/lib/fleet-work
STATE=/var/lib/fleet-dao/engine
# 工作树的根、引擎状态目录钉对了的两行：前面的用例只看端口和名单，都带上它们；看这两个键的用例把 TAIL 换掉
PINS="FLEET_WORK_DIR=$WORK
FLEET_ENGINE_STATE_DIR=$STATE"
TAIL=$PINS
engine_case() { # 说明 期望（ok / pending / red） 文件内容 [输出里要有的字]
  local what=$1 want=$2 words=${4:-} got=ok rc_ok=0
  printf '%s\n%s\n' "$3" "$TAIL" >"$T/check-engine.env"
  call check_engine_env "$T/check-engine.env" "$LIST" "$WORK" "$STATE"
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
engine_case '真端口、名单钉对了' ok "FLEET_ENGINE_PORTS=real
FLEET_SENSITIVE_VALUES_FILE=$LIST"
engine_case '值带引号（去一层）' ok "FLEET_ENGINE_PORTS=\"real\"
FLEET_SENSITIVE_VALUES_FILE='$LIST'"
engine_case '假端口' pending "FLEET_ENGINE_PORTS=fake
FLEET_SENSITIVE_VALUES_FILE=$LIST" 'fake'
engine_case 'real 在前、fake 在后：生效的是 fake，写了两行判红' red "FLEET_ENGINE_PORTS=real
FLEET_ENGINE_PORTS=fake
FLEET_SENSITIVE_VALUES_FILE=$LIST" '「fake」'
engine_case '缩进、KEY = 值照样认' pending "   FLEET_ENGINE_PORTS = fake
FLEET_SENSITIVE_VALUES_FILE=$LIST" 'fake'
engine_case '没写端口实现（要人定）' red "FLEET_SENSITIVE_VALUES_FILE=$LIST" 'FLEET_ENGINE_PORTS'
engine_case '端口实现被注释掉' red "# FLEET_ENGINE_PORTS=real
FLEET_SENSITIVE_VALUES_FILE=$LIST" '注释'
engine_case '端口实现不认识' red "FLEET_ENGINE_PORTS=maybe
FLEET_SENSITIVE_VALUES_FILE=$LIST" '「maybe」'
engine_case '名单钉在别处' red "FLEET_ENGINE_PORTS=real
FLEET_SENSITIVE_VALUES_FILE=/home/fleet/.fleet-dao/sensitive-values.txt" '不是同一处'
engine_case '没钉名单' pending 'FLEET_ENGINE_PORTS=real' '补上'
engine_case '名单那一行被注释掉' pending "FLEET_ENGINE_PORTS=real
# FLEET_SENSITIVE_VALUES_FILE=$LIST" '注释'
# 补键只补缺、不改已有的：机器上留着的旧值只有读回拦得住
TAIL="FLEET_ENGINE_STATE_DIR=$STATE"
engine_case '工作树的根是旧值 /tmp' red "FLEET_ENGINE_PORTS=real
FLEET_SENSITIVE_VALUES_FILE=$LIST
FLEET_WORK_DIR=/tmp" '「/tmp」'
engine_case '没写工作树的根' pending "FLEET_ENGINE_PORTS=real
FLEET_SENSITIVE_VALUES_FILE=$LIST" 'FLEET_WORK_DIR'
engine_case '工作树的根写了两行' red "FLEET_ENGINE_PORTS=real
FLEET_SENSITIVE_VALUES_FILE=$LIST
FLEET_WORK_DIR=$WORK
FLEET_WORK_DIR=/tmp" '写了 2 行'
TAIL="FLEET_WORK_DIR=$WORK"
engine_case '引擎状态目录不对' red "FLEET_ENGINE_PORTS=real
FLEET_SENSITIVE_VALUES_FILE=$LIST
FLEET_ENGINE_STATE_DIR=/var/tmp/engine" '「/var/tmp/engine」'
engine_case '引擎状态目录被注释掉' pending "FLEET_ENGINE_PORTS=real
FLEET_SENSITIVE_VALUES_FILE=$LIST
# FLEET_ENGINE_STATE_DIR=$STATE" '注释'
TAIL=$PINS

call check_engine_env "$T/no-such-engine.env" "$LIST" "$WORK" "$STATE"
missing_out=$OUT
expect_red_untouched "engine.env 不在" "$T/no-such-engine.env" "不在"
call check_engine_env "$T/dir.env" "$LIST" "$WORK" "$STATE"
dir_out=$OUT
expect_red_untouched "engine.env 是个目录" "$T/dir.env" "目录"
printf 'FLEET_ENGINE_PORTS="real\n' >"$T/openquote-engine.env"
before=$(digest "$T/openquote-engine.env")
call check_engine_env "$T/openquote-engine.env" "$LIST" "$WORK" "$STATE"
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

echo "== 第一次照样例建：要人定的键不替人选"
printf '# 说明\nFLEET_ENGINE_PORTS=real\nTEMPORAL_ADDRESS=127.0.0.1:7243\n' >"$T/new-example.env"
if new_content=$(example_for_new_file "$T/new-example.env"); then
  printf '%s\n' "$new_content" >"$T/new-engine.env"
  call check_engine_env "$T/new-engine.env" "$LIST" "$WORK" "$STATE"
  if ((RC != 0)) && [[ "$(env_value "$T/new-engine.env" TEMPORAL_ADDRESS)" == 127.0.0.1:7243 && "$OUT" == *"FLEET_ENGINE_PORTS"* ]]; then
    pass "样例里的 FLEET_ENGINE_PORTS=real 建出来是注释，读回判红；别的键照抄"
  else
    flunk "建出来的文件该没有生效的端口实现、读回判红（返回 $RC）：$OUT"
  fi
  call add_missing_keys "$T/new-engine.env" "$T/new-example.env"
  if [[ "$(env_value "$T/new-engine.env" FLEET_ENGINE_PORTS 2>/dev/null)" == "" ]]; then
    pass "补键也不把它补回来"
  else
    flunk "补键把要人定的键补回来了"
  fi
else
  flunk "读得到的样例该建得出来"
fi
if example_for_new_file "$T/no-such-example.env" >/dev/null; then flunk "样例不在该回非 0"; else pass "样例不在：回非 0，不建"; fi

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
