#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 已退役的飞书网关（#2184 删了部署，#2226）：deploy/hk.sh 装机时把香港上它留下的东西清掉，读回核对都不在。
# - 单元 fleet-feishu.service 停掉、禁用、删掉；发布目录和收版本的脚本先打包（root 600）再删；令牌文件、网关专用的 node 直接删；
# - 已经没有就什么都不动（幂等）；
# - 【故意造出的失败】停不掉、打包不成（不删）、还留着、authorized_keys2 里还有发网关的那一行，都判红。
# 不碰真机器：hk.sh 里那几个函数原样摘出来，路径都换进临时目录，systemctl、install 换成桩。
# 用法：bash deploy/test/hk-retired-gateway.test.sh（不用 root）。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HK=$HERE/../hk.sh
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

echo "== hk.sh 真有清和读回这两步，清单里是网关的那几样"
check "retire_gateway 在装机里调了一次" "$(grep -c '^ *retire_gateway$' "$HK")" 1
check "readback_retired_gateway 在读回里调了一次" "$(grep -c '^ *readback_retired_gateway$' "$HK")" 1
check "单元清单是 fleet-feishu.service" "$(grep -c '^RETIRED_UNITS=(fleet-feishu.service)$' "$HK")" 1
for p in /srv/fleet-dao-gateway /usr/local/sbin/fleet-gateway-deploy; do
  check "$p 删前打包" "$(grep -c "^RETIRED_KEEP=(.*$p" "$HK")" 1
done
for p in feishu.env gateway-token.env "node-v\\*"; do
  check "$p 在直接删的清单里" "$(grep -A1 '^RETIRED_DROP=(' "$HK" | grep -c "$p")" 1
done

extract() { awk -v name="$1" '$0 ~ "^" name "\\(\\) \\{$" { on = 1 } on { print } on && /^}$/ { exit }' "$HK"; }
FUNCS=$(
  extract retired_drop_present
  extract retire_gateway
  extract readback_retired_gateway
)
check "摘到了那三个函数" "$(grep -c -e '^retired_drop_present() {' -e '^retire_gateway() {' -e '^readback_retired_gateway() {' <<<"$FUNCS")" 3

REDS=()
LOG=()
step() { :; }
red() { REDS+=("$1"); }
changed() { LOG+=("changed $1"); }
ok() { LOG+=("ok $1"); }
ROOT=$TMP/root
# 下面这几个变量由摘出来的函数读
# shellcheck disable=SC2034
RETIRED_UNITS=(fleet-feishu.service)
RETIRED_UNIT_DIR=$ROOT/etc/systemd/system
# shellcheck disable=SC2034
RETIRED_KEEP=("$ROOT/srv/fleet-dao-gateway" "$ROOT/usr/local/sbin/fleet-gateway-deploy")
# shellcheck disable=SC2034
RETIRED_DROP=("$ROOT/etc/fleet-dao/feishu.env" "$ROOT/etc/fleet-dao/feishu.env.bak-*" "$ROOT/etc/fleet-dao/gateway-token.env"
  "$ROOT/opt/fleet-dao/node" "$ROOT/opt/fleet-dao/node-v*")
RETIRED_BACKUP_DIR=$ROOT/var/backups/fleet-dao
UPLOAD_KEYS_FILE=$ROOT/root/.ssh/authorized_keys2
STATE=$TMP/state
RELOADS=0
STUCK=0
systemctl() {
  case $1 in
  is-active)
    if [[ -f "$STATE/$2" ]]; then cat -- "$STATE/$2"; else echo inactive; fi
    ;;
  disable)
    if ((STUCK)); then return 1; fi
    if [[ -f "$STATE/$3" ]]; then echo inactive >"$STATE/$3"; fi
    ;;
  daemon-reload) RELOADS=$((RELOADS + 1)) ;;
  esac
}
install() { mkdir -p -- "${@: -1}"; } # 只有建备份目录用到它；-o root 不用 root 跑不了
# shellcheck disable=SC1090 # 摘出来的函数
source <(printf '%s\n' "$FUNCS")

old_machine() { # 摆出香港老机器的样子（2026-10-15 实看的路径）
  rm -rf -- "$ROOT" "$STATE"
  mkdir -p "$RETIRED_UNIT_DIR" "$STATE" "$ROOT/srv/fleet-dao-gateway/abc" "$ROOT/usr/local/sbin" "$ROOT/etc/fleet-dao" \
    "$ROOT/opt/fleet-dao/node-v22.23.3/bin" "$ROOT/root/.ssh" "$ROOT/srv/fleet-dao-web"
  : >"$RETIRED_UNIT_DIR/fleet-feishu.service"
  echo inactive >"$STATE/fleet-feishu.service"
  echo 'gateway' >"$ROOT/srv/fleet-dao-gateway/abc/gateway.mjs"
  ln -s abc "$ROOT/srv/fleet-dao-gateway/current"
  echo '#!/bin/sh' >"$ROOT/usr/local/sbin/fleet-gateway-deploy"
  : >"$ROOT/etc/fleet-dao/feishu.env"
  : >"$ROOT/etc/fleet-dao/feishu.env.bak-20260925071039"
  : >"$ROOT/etc/fleet-dao/gateway-token.env"
  : >"$ROOT/etc/fleet-dao/hk.env"
  : >"$ROOT/etc/fleet-dao/backup.env"
  : >"$ROOT/opt/fleet-dao/node-v22.23.3/bin/node"
  ln -s node-v22.23.3 "$ROOT/opt/fleet-dao/node"
  printf '# fleet-dao\nfrom="10.99.0.2",restrict,command="/usr/bin/rrsync -wo -munge /srv/fleet-dao-web" ssh-ed25519 AAA up\n' >"$UPLOAD_KEYS_FILE"
  REDS=()
  LOG=()
  RELOADS=0
  STUCK=0
}
left() { # 网关留下的还剩什么（相对 $ROOT）
  (cd "$ROOT" && find etc/systemd srv/fleet-dao-gateway usr/local/sbin/fleet-gateway-deploy etc/fleet-dao/feishu.env* \
    etc/fleet-dao/gateway-token.env opt/fleet-dao/node opt/fleet-dao/node-v22.23.3 -maxdepth 0 \( -type f -o -type l -o -type d \) \
    ! -name systemd 2>/dev/null | sort | tr '\n' ' ')
}

echo "== 老机器：清干净、打了包、别的不碰"
old_machine
retire_gateway
check "单元、目录、脚本、令牌文件、node 都没了，没有红" "$(left):${#REDS[@]}" ":0"
check "daemon-reload 一次" "$RELOADS" 1
mapfile -t TARS < <(find "$RETIRED_BACKUP_DIR" -name 'retired-feishu-gateway-*.tar.gz')
check "打了一个包" "${#TARS[@]}" 1
check "包里有网关目录和收版本的脚本，没有令牌文件" \
  "$(tar -tzf "${TARS[0]}" | grep -c -e 'srv/fleet-dao-gateway/abc/gateway.mjs' -e 'usr/local/sbin/fleet-gateway-deploy'):$(tar -tzf "${TARS[0]}" | grep -c 'feishu.env\|gateway-token')" "2:0"
check "包是 600" "$(stat -c '%a' -- "${TARS[0]}")" 600
check "别的不碰：hk.env、backup.env、上传钥匙文件、静态目录、/opt/fleet-dao 本身都在" \
  "$(cd "$ROOT" && find etc/fleet-dao/hk.env etc/fleet-dao/backup.env root/.ssh/authorized_keys2 srv/fleet-dao-web opt/fleet-dao -maxdepth 0 | tr '\n' ' ')" \
  "etc/fleet-dao/hk.env etc/fleet-dao/backup.env root/.ssh/authorized_keys2 srv/fleet-dao-web opt/fleet-dao "
REDS=()
LOG=()
readback_retired_gateway
check "读回：都不在了，通过" "${#REDS[@]}:${LOG[0]%%（*}" "0:ok 已退役的飞书网关留下的单元、目录、令牌文件都不在了"
LOG=()
RELOADS=0
retire_gateway
check "再来一遍：幂等，什么都不动、不 reload、不再打包" \
  "${#LOG[@]}:$RELOADS:${#REDS[@]}:$(find "$RETIRED_BACKUP_DIR" -name '*.tar.gz' | wc -l)" "0:0:0:1"

echo "== 【故意造出的失败】"
old_machine
echo active >"$STATE/fleet-feishu.service"
STUCK=1
retire_gateway
check "停不掉（还在跑）：判红，单元文件不删" \
  "$(printf '%s\n' "${REDS[@]}" | grep -c '停不掉'):$([[ -e "$RETIRED_UNIT_DIR/fleet-feishu.service" ]] && echo 在 || echo 没了)" "1:在"
REDS=()
readback_retired_gateway
check "读回：在跑的单元判红" "$(printf '%s\n' "${REDS[@]}" | grep -c 'fleet-feishu.service 还在')" 1

old_machine
: >"$ROOT/var-is-file"
RETIRED_BACKUP_DIR=$ROOT/var-is-file/sub # 建不成备份目录
retire_gateway
check "打包不成：判红，网关目录和脚本都不删" \
  "$(printf '%s\n' "${REDS[@]}" | grep -c '打包.*没成'):$(cd "$ROOT" && find srv/fleet-dao-gateway usr/local/sbin/fleet-gateway-deploy -maxdepth 0 2>/dev/null | wc -l)" "1:2"
REDS=()
LOG=()
readback_retired_gateway
check "读回：留着的目录和脚本判红" "$(printf '%s\n' "${REDS[@]}" | grep -c '留下的.*还在')" 2
RETIRED_BACKUP_DIR=$ROOT/var/backups/fleet-dao

old_machine
retire_gateway
echo 'from="10.99.0.2",restrict,command="/usr/local/sbin/fleet-gateway-deploy" ssh-ed25519 BBB gw' >>"$UPLOAD_KEYS_FILE"
: >"$ROOT/etc/fleet-dao/feishu.env.bak-20261001"
REDS=()
readback_retired_gateway
check "读回：authorized_keys2 里还有发网关的那一行、又冒出一份 feishu.env 备份，都判红" \
  "$(printf '%s\n' "${REDS[@]}" | grep -c -e '发飞书网关的那一行' -e 'feishu.env.bak-20261001 还在')" 2

if ((fail)); then
  echo "hk-retired-gateway：不通过"
  exit 1
fi
echo "hk-retired-gateway：通过"
