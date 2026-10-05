#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2317,SC2329 # 替身函数由被测代码间接调用，shellcheck 看不出来
# deploy/france.sh 里 Temporal 表结构那一段（schema_version、temporal_schema；审查 S5），每种情况各造一次：
#   1. 连不上库（psql 退出 2）、回的认不出：读版本号返回失败，判红、不建版本表也不升级（temporal-sql-tool 一次都不调）——
#      原来连不上库被当成「还没有版本表」，接着对已有的库跑 setup-schema -v 0.0；
#   2. 还没有版本表：先建、再升，记一处改动；已有版本表：只升，版本号没变记好、变了记改动；
#   3. 升完再读版本号读不到：判红，不说「没动」。
# 函数从 france.sh 里原样摘出来跑（france.sh 自己会跑 main，不能 source），psql、temporal-sql-tool 换成替身，不连库。
# 用法：bash deploy/test/temporal-schema.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

body=$(sed -n -e '/^schema_version() {/,/^}/p' -e '/^temporal_schema() {/,/^}/p' "$HERE/../france.sh")
eval "$body"

# 替身库：PG=ok 有版本表（版本号 VER）；empty 还没有版本表；down 连不上；garbled 回的认不出。
# 替身 temporal-sql-tool：setup-schema 建出版本表（0.0），update-schema 升到 NEXT；DOWN_AFTER=1 时升完库就连不上了
PG=ok
VER=1.10
NEXT=1.10
DOWN_AFTER=0
pg_admin() {
  echo "pg $*" >>"$T/calls"
  case $PG in
  down)
    echo 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory' >&2
    return 2
    ;;
  garbled)
    echo 'WARNING:  could not flush dirty data'
    return 0
    ;;
  esac
  case $* in
  *to_regclass*) if [[ "$PG" == empty ]]; then echo f; else echo t; fi ;;
  *curr_version*) echo "$VER" ;;
  esac
}
sql_tool() {
  echo "sql $*" >>"$T/calls"
  case $* in
  *setup-schema*)
    PG=ok
    VER=0.0
    ;;
  *update-schema*)
    VER=$NEXT
    if ((DOWN_AFTER)); then PG=down; fi
    ;;
  esac
}
round() { # 库怎么答 版本号 升到几
  PG=$1 VER=$2 NEXT=$3 DOWN_AFTER=0
  : >"$T/calls"
  REDS=()
  CHANGES=()
  PENDING=()
}
sql_calls() { grep -c '^sql' "$T/calls"; }
reds_with() { printf '%s\n' "${REDS[@]}" | grep -cF -- "$1"; }

echo "== 读版本号：连不上库、回的认不出返回失败，不当成「还没有版本表」"
round down 1.10 1.10
got=$(schema_version temporal 2>"$T/err")
check "【故意造出的失败】连不上库：返回失败" "$?" 1
check "连不上库：没打出版本号" "$got" ""
check "连不上库：原因在 stderr" "$(grep -c 'connection to server' "$T/err")" 1
round garbled 1.10 1.10
schema_version temporal >/dev/null 2>"$T/err"
check "【故意造出的失败】回的认不出：返回失败" "$?" 1
check "回的认不出：stderr 里说认不出" "$(grep -c '回的认不出' "$T/err")" 1
round empty 1.10 1.10
got=$(schema_version temporal)
check "还没有版本表：返回 0、打印空" "$?:$got" "0:"
round ok 1.10 1.10
got=$(schema_version temporal)
check "有版本表：打印版本号" "$?:$got" "0:1.10"

echo "== 一个库的表结构：读不到就判红、不建不升；没有版本表先建再升；升完读不到也判红"
round down 1.10 1.10
temporal_schema temporal postgresql/v12/temporal >"$T/out" 2>&1
check "【故意造出的失败】连不上库：失败" "$?" 1
check "连不上库：temporal-sql-tool 一次都没调（不对已有的库跑 setup-schema）" "$(sql_calls)" 0
check "连不上库：红里说清" "$(reds_with '读库 temporal 的表结构版本没成（连不上库或查询报错，不当成「还没有版本表」）')" 1
check "连不上库：红里带 psql 的原话" "$(reds_with 'connection to server')" 1
round garbled 1.10 1.10
temporal_schema temporal postgresql/v12/temporal >"$T/out" 2>&1
check "回的认不出：失败、temporal-sql-tool 一次都没调" "$?:$(sql_calls)" "1:0"
round empty 1.10 1.12
temporal_schema temporal_visibility postgresql/v12/visibility >"$T/out" 2>&1
check "还没有版本表：成功、没有红" "$?:${#REDS[@]}" "0:0"
check "还没有版本表：先建再升" "$(grep '^sql' "$T/calls" | grep -oE 'setup-schema|update-schema' | paste -sd ' ' -)" "setup-schema update-schema"
check "还没有版本表：记一处改动" "$(printf '%s\n' "${CHANGES[@]}" | grep -c '库 temporal_visibility 表结构 （空） → 1.12')" 1
round ok 1.12 1.12
temporal_schema temporal postgresql/v12/temporal >"$T/out" 2>&1
check "已有、版本没变：成功、不建、只升、改动 0 处" "$?:$(grep -c setup-schema "$T/calls"):$(grep -c update-schema "$T/calls"):${#CHANGES[@]}" "0:0:1:0"
round ok 1.11 1.12
temporal_schema temporal postgresql/v12/temporal >"$T/out" 2>&1
check "已有、升了一版：记改动" "$(printf '%s\n' "${CHANGES[@]}" | grep -c '库 temporal 表结构 1.11 → 1.12')" 1
round ok 1.11 1.12
DOWN_AFTER=1
temporal_schema temporal postgresql/v12/temporal >"$T/out" 2>&1
check "【故意造出的失败】升完读版本号读不到：失败、判红、不说没动" "$?:$(reds_with '升级完读库 temporal 的表结构版本没成'):${#CHANGES[@]}" "1:1:0"

if ((fail)); then
  echo "temporal-schema：不通过"
  exit 1
fi
echo "temporal-schema：通过"
