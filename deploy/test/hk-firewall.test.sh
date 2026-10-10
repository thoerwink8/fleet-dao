#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 香港防火墙基线（deploy/hk.sh 的 setup_firewall、readback_firewall）。
# 不碰真机器：ufw、ss 是 PATH 里的桩。
#   1. 全对（ufw 开着、默认拒绝、白名单都放了、对公网只听白名单和别家 8443）→ 读回全绿，装一遍不改 ufw
#   2. 白名单里有而没在听（443）→ 只一行 ok，不红；回环和 10.99.0.1 上的口不算对公网
#   3. 【故意造出的失败】临时多开一个对公网的端口 → 红，点名端口和进程；不删别家规则
#   4. 【故意造出的失败】ufw 没开 → 读回红，装机红字停下且不执行 ufw enable
#   5. 【故意造出的失败】ufw 命令失败、输出认不出、默认入站不是拒绝 → 都红（失败记「没查成」，不当成没问题）
#   6. 缺规则时第一遍补上；第二遍零改动（不调用任何改 ufw 的命令）；别家 8443（注释 self-proxy）原样留着
#   7. 只有出站 ALLOW OUT（v6 那行的 ALLOW IN 也不算 v4 已放行）→ 不当成已放行：先补入站 ufw allow，
#      再把默认入站改成拒绝。默认已经是拒绝时也要补。第二遍零改动。别家 8443 不动
# 用法：bash deploy/test/hk-firewall.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HK=$HERE/../hk.sh
OPS=$HERE/../../docs/ops.md
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
FWDIR=$TMP/fw
mkdir -p "$FWDIR" "$TMP/bin"
export FWDIR
export PATH="$TMP/bin:$PATH"

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的一段
  if [[ "$2" == *"$3"* ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
# 改 ufw 的命令（status 是读，不算）
mutating() {
  grep -E '^(allow|default|delete|insert|enable|disable|reset|reload|deny|reject|limit|route)( |$)' "$FWDIR/log" || true
}
fresh() {
  CHANGES=()
  REDS=()
  PENDING=()
  : >"$FWDIR/log"
  : >"$FWDIR/ss-log"
}

cat >"$TMP/bin/ufw" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >>"$FWDIR/log"
cmd=$1
shift
case "$cmd" in
status)
  rc=$(cat "$FWDIR/rc")
  if [[ "$rc" != 0 ]]; then
    echo "ERROR: ufw failed" >&2
    exit "$rc"
  fi
  mode=$(cat "$FWDIR/mode")
  if [[ "$mode" == garbage ]]; then
    echo "Status: confused and loud"
    exit 0
  fi
  printf 'Status: %s\n' "$mode"
  [[ "$mode" == active ]] || exit 0
  if [[ "${1:-}" == verbose ]]; then
    echo "Logging: on (low)"
    if [[ -f "$FWDIR/no-default" ]]; then
      echo "Logging stays on"
    else
      printf 'Default: %s (incoming), allow (outgoing), disabled (routed)\n' "$(cat "$FWDIR/default")"
    fi
    echo "New profiles: skip"
  fi
  echo
  echo "To                         Action      From"
  echo "--                         ------      ----"
  action=ALLOW
  [[ "${1:-}" == verbose ]] && action="ALLOW IN"
  [[ -s "$FWDIR/rules" ]] || exit 0
  # 第三列 out：这条只是出站。verbose 下打成 ALLOW OUT，用来核对「出站不算已放行入站」。
  # read 会把连续的制表符并成一个分隔，空注释的第三列会丢，所以按行拆。
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    spec=${line%%$'\t'*}
    rest=${line#*$'\t'}
    cmt= dir=
    if [[ "$rest" != "$line" ]]; then
      cmt=${rest%%$'\t'*}
      [[ "$rest" == *$'\t'* ]] && dir=${rest#*$'\t'}
    fi
    act=$action
    if [[ "$dir" == out ]]; then
      act=ALLOW
      [[ "${1:-}" == verbose ]] && act="ALLOW OUT"
    fi
    if [[ -n "$cmt" ]]; then
      printf '%s                     %s    Anywhere                   # %s\n' "$spec" "$act" "$cmt"
      printf '%s (v6)                %s    Anywhere (v6)              # %s\n' "$spec" "$act" "$cmt"
    else
      printf '%s                     %s    Anywhere\n' "$spec" "$act"
      printf '%s (v6)                %s    Anywhere (v6)\n' "$spec" "$act"
    fi
  done <"$FWDIR/rules"
  ;;
allow)
  spec=$1
  cmt=
  if [[ "${2:-}" == comment ]]; then cmt=$3; fi
  printf '%s\t%s\n' "$spec" "$cmt" >>"$FWDIR/rules"
  ;;
default)
  printf '%s\n' "$1" >"$FWDIR/default"
  rm -f -- "$FWDIR/no-default"
  ;;
*)
  echo "ufw 桩不认：$cmd $*" >&2
  exit 99
  ;;
esac
EOF
cat >"$TMP/bin/ss" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >>"$FWDIR/ss-log"
cat "$FWDIR/ss-out"
exit "$(cat "$FWDIR/ss-rc")"
EOF
chmod +x "$TMP/bin/ufw" "$TMP/bin/ss"

# 全对的样子：本仓四条 + 别家 8443（注释 self-proxy）；对公网只听这些。回环、%lo、10.99.0.1 上另有口。
good_rules() {
  printf '%s\t%s\n' \
    22/tcp '' \
    80/tcp '' \
    443/tcp '' \
    4500/udp 'fleet-dao wireguard' \
    8443/tcp 'self-proxy' >"$FWDIR/rules"
}
# 本仓四条只有出站；别家 8443 仍是入站（注释 self-proxy），不该被改
out_only_rules() {
  printf '%s\t%s\t%s\n' \
    22/tcp '' out \
    80/tcp '' out \
    443/tcp '' out \
    4500/udp 'fleet-dao wireguard' out >"$FWDIR/rules"
  printf '%s\t%s\n' 8443/tcp self-proxy >>"$FWDIR/rules"
}
good_ss() {
  cat >"$FWDIR/ss-out" <<'EOF'
tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))
tcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=1,fd=4))
tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=2,fd=6))
tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=2,fd=7))
tcp LISTEN 0 511 [::]:443 [::]:* users:(("nginx",pid=2,fd=8))
tcp LISTEN 0 511 0.0.0.0:8443 0.0.0.0:* users:(("self-proxy",pid=3,fd=3))
tcp LISTEN 0 511 [::]:8443 [::]:* users:(("self-proxy",pid=3,fd=4))
udp UNCONN 0 0 0.0.0.0:4500 0.0.0.0:*
udp UNCONN 0 0 [::]:4500 [::]:*
tcp LISTEN 0 511 127.0.0.1:4331 0.0.0.0:* users:(("miraquota-hub",pid=4,fd=5))
udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*
tcp LISTEN 0 128 [::1]:631 [::]:* users:(("cupsd",pid=6,fd=1))
tcp LISTEN 0 128 10.99.0.1:51820 0.0.0.0:* users:(("not-public",pid=5,fd=1))
EOF
  echo 0 >"$FWDIR/ss-rc"
}
set_ufw() { # active|inactive|garbage  退出码  默认策略
  printf '%s\n' "$1" >"$FWDIR/mode"
  printf '%s\n' "$2" >"$FWDIR/rc"
  printf '%s\n' "$3" >"$FWDIR/default"
  rm -f -- "$FWDIR/no-default"
}

# shellcheck source=../hk.sh
source "$HK"
set +e
trap - ERR

for fn in setup_firewall readback_firewall; do
  if ! declare -F "$fn" >/dev/null; then
    echo "hk-firewall：不通过：hk.sh 没有 $fn"
    exit 1
  fi
done

run_setup() {
  fresh
  setup_firewall >"$FWDIR/out" 2>&1
  RC=$?
  OUT=$(<"$FWDIR/out")
}
run_readback() {
  fresh
  readback_firewall >"$FWDIR/out" 2>&1
  RC=$?
  OUT=$(<"$FWDIR/out")
}

echo "== 约定里的白名单，和 ops.md 对得上"
check "本仓白名单" "${HK_FW_OURS[*]-}" "22/tcp 80/tcp 443/tcp 4500/udp"
check "别家登记只有 8443/tcp" "${HK_FW_FOREIGN[*]-}" "8443/tcp"
block=$(awk 'BEGIN { p = 0 } /^# ── 约定/{ p = 1 } /^FLEET_DOMAIN=/{ exit } p' "$HK")
has "约定注释写了不归本仓管" "$block" "不归本仓管"
has "约定注释指向 ops.md 端口表" "$block" "ops.md"
row13=$(sed -n '13p' "$OPS")
for p in 22/tcp 80/tcp 443/tcp 4500/udp 8443/tcp; do
  has "公网入站行有 $p" "$row13" "$p"
done
has "公网入站行写明白名单在 deploy/hk.sh" "$row13" "deploy/hk.sh"
has "公网入站行写明在约定里改" "$row13" "约定"
ops_text=$(<"$OPS")
has "香港端口表写了改 HK_FW_OURS" "$ops_text" "HK_FW_OURS"
has "香港端口表写了改 HK_FW_FOREIGN" "$ops_text" "HK_FW_FOREIGN"
check "变量端口表的 WG_PORT 行还在" "$(grep -cF '| WG_PORT | 4500 | deploy/hk.sh |' "$OPS")" 1
check "两张端口明细表的表头都还在" "$(grep -cF '| 端口 | 绑在 | 是谁 | 说明 |' "$OPS")" 2
check "香港表有 22/tcp" "$(grep -cF '| 22/tcp |' "$OPS")" 1
check "8443 那行仍写着别动" "$(grep -cF '8443/tcp' "$OPS" | awk '{ print ($1 >= 1) ? "有" : "没有" }')" 有
has "8443 说明仍是别动" "$(grep -F '8443/tcp' "$OPS")" "别动"
sf=$(grep -n '^    setup_firewall$' "$HK" | head -1 | cut -d: -f1)
# shellcheck disable=SC2016 # 匹配 hk.sh 里的原文 $(snapshot_others)，不是在这里展开
sn=$(grep -n '^    before=$(snapshot_others)$' "$HK" | head -1 | cut -d: -f1)
check "setup_firewall 在快照之前" "$((sf < sn))" 1
check "readback 调用了 readback_firewall" "$(awk 'BEGIN{p=0} /^readback\(\) \{/{p=1} p{print} p && /^}$/{exit}' "$HK" | grep -c '^  readback_firewall$')" 1

echo "== 1. 全对 → 绿；装一遍不改 ufw"
set_ufw active 0 deny
good_rules
good_ss
run_readback
check "读回返回 0" "$RC" 0
check "没有红、没有待配" "${#REDS[@]} ${#PENDING[@]}" "0 0"
has "默认拒绝" "$OUT" "默认拒绝入站"
has "对公网都在白名单里" "$OUT" "对公网在听的端口都在白名单里"
check "443 在听，不提还没在听" "$(grep -c '还没在听' <<<"$OUT" || true)" 0
check "ss 要进程名（-Hltunp）" "$(<"$FWDIR/ss-log")" "-Hltunp"
run_setup
check "装返回 0" "$RC" 0
check "没有改动" "${#CHANGES[@]}" 0
check "没有改 ufw 的命令" "$(mutating)" ""
check "8443 规则还在" "$(grep -c $'^8443/tcp\tself-proxy$' "$FWDIR/rules")" 1

echo "== 2. 白名单里 80、443 没在听：只一行 ok，不红"
grep -v -E ':(80|443) ' "$FWDIR/ss-out" >"$FWDIR/ss-cut" || true
mv -- "$FWDIR/ss-cut" "$FWDIR/ss-out"
run_readback
check "返回 0" "$RC" 0
check "没有红" "${#REDS[@]}" 0
check "只一行说明没在听" "$(grep -c '还没在听' <<<"$OUT" || true)" 1
has "点了 80 和 443" "$OUT" "80/tcp、443/tcp"
check "没把回环和隧道地址算成多开" "$(grep -c -E '4331|51820|cupsd|127.0.0.53' <<<"${REDS[*]}" || true)" 0

echo "== 3.【故意造出的失败】对公网多开 9999/tcp：红且点名；别家规则不动"
good_ss
printf '%s\n' 'tcp LISTEN 0 128 0.0.0.0:9999 0.0.0.0:* users:(("evil-nc",pid=9,fd=3))' >>"$FWDIR/ss-out"
printf '%s\t%s\n' 9999/tcp someone >>"$FWDIR/rules"
run_readback
check "读回返回 0（红记在结论里，不在这一步停下）" "$RC" 0
check "一条红" "${#REDS[@]}" 1
has "点名端口" "${REDS[*]}" "9999/tcp"
has "点名进程" "${REDS[*]}" "evil-nc"
check "没点回环和隧道上的口" "$(grep -c -E '4331|51820|cupsd' <<<"${REDS[*]}" || true)" 0
run_setup
check "规则已经齐、默认已是拒绝：不改 ufw" "$(mutating)" ""
check "不删 9999 这条别家规则" "$(grep -c $'^9999/tcp\tsomeone$' "$FWDIR/rules")" 1
check "不删 8443" "$(grep -c $'^8443/tcp\tself-proxy$' "$FWDIR/rules")" 1

echo "== 4.【故意造出的失败】ufw 没开 → 红，且不替人开"
set_ufw inactive 0 deny
good_rules
good_ss
run_readback
check "读回有红" "${#REDS[@]}" 1
has "红在没开" "${REDS[*]}" "ufw 没开"
check "不当成待配" "${#PENDING[@]}" 0
run_setup
check "装机停下" "$RC" 1
has "红字说明不替人开" "${REDS[*]}" "不替人开"
check "没有 ufw enable，也没有别的改动" "$(mutating)" ""

echo "== 5.【故意造出的失败】ufw 失败或认不出 → 红，记没查成"
set_ufw active 1 deny
run_readback
check "命令失败：一条红、没有待配" "${#REDS[@]} ${#PENDING[@]}" "1 0"
has "命令失败记没查成" "${REDS[*]}" "没查成"
has "点明是命令失败" "${REDS[*]}" "命令失败"
run_setup
check "装机停下" "$RC" 1
check "失败时不改规则" "$(mutating)" ""

set_ufw garbage 0 deny
run_readback
check "认不出：一条红、没有待配" "${#REDS[@]} ${#PENDING[@]}" "1 0"
has "认不出记没查成" "${REDS[*]}" "没查成"
has "点明输出认不出" "${REDS[*]}" "输出认不出"

set_ufw active 0 allow
good_rules
: >"$FWDIR/no-default"
run_readback
check "没有默认策略：红" "${#REDS[@]}" 1
has "默认策略认不出也记没查成" "${REDS[*]}" "没查成"

rm -f -- "$FWDIR/no-default"
set_ufw active 0 allow
good_ss
run_readback
check "默认放行：一条红" "${#REDS[@]}" 1
has "点明不是拒绝" "${REDS[*]}" "不是拒绝"
has "点明现在是 allow" "${REDS[*]}" "allow"

echo "== 6. 第一遍补齐；第二遍零改动；8443 不被动"
printf '%s\t%s\n' 8443/tcp self-proxy >"$FWDIR/rules"
set_ufw active 0 allow
good_ss
run_setup
check "第一遍返回 0" "$RC" 0
check "第一遍只补四条放行和默认拒绝" "$(mutating)" "$(printf '%s\n' \
  'allow 22/tcp comment fleet-dao ssh' \
  'allow 80/tcp comment fleet-dao http' \
  'allow 443/tcp comment fleet-dao https' \
  'allow 4500/udp comment fleet-dao wireguard' \
  'default deny incoming')"
check "第一遍的命令里没有 8443" "$(grep -c 8443 "$FWDIR/log" || true)" 0
check "8443 仍是原来那一条" "$(grep -c $'^8443/tcp\tself-proxy$' "$FWDIR/rules")" 1
check "没有第二条 8443" "$(grep -c '^8443/tcp' "$FWDIR/rules")" 1
# 第二遍：状态留着，只清调用记录
fresh
setup_firewall >"$FWDIR/out" 2>&1
RC=$?
check "第二遍返回 0" "$RC" 0
check "第二遍没有改动记录" "${#CHANGES[@]}" 0
check "第二遍没有红" "${#REDS[@]}" 0
check "第二遍只读了状态" "$(<"$FWDIR/log")" "status verbose"
check "第二遍没有改 ufw 的命令" "$(mutating)" ""
check "第二遍之后 8443 还在" "$(grep -c $'^8443/tcp\tself-proxy$' "$FWDIR/rules")" 1
run_readback
check "补完再读回：没有红" "${#REDS[@]}" 0

echo "== 7. 只有 ALLOW OUT、没有 ALLOW IN：不当成已放行，先补入站再收紧默认"
yn_allowed() {
  if hk_fw_allowed "$1"; then printf yes; else printf no; fi
}
# v4 是出站，v6 即使是 ALLOW IN 也不算 v4 已放行（缺 v4 时 ufw allow 会补）
HK_FW_STATUS=$'22/tcp                     ALLOW OUT   Anywhere\n22/tcp (v6)                ALLOW IN    Anywhere (v6)'
check "v4 的 ALLOW OUT 不算已放行" "$(yn_allowed 22/tcp)" no
HK_FW_STATUS=$'22/tcp                     ALLOW IN    Anywhere\n22/tcp                     ALLOW OUT   Anywhere'
check "同一端口有 ALLOW IN 就算已放行" "$(yn_allowed 22/tcp)" yes

out_only_rules
set_ufw active 0 allow
good_ss
run_setup
check "默认还是放行、只有出站：返回 0" "$RC" 0
check "先补四条入站，再把默认改成拒绝" "$(mutating)" "$(printf '%s\n' \
  'allow 22/tcp comment fleet-dao ssh' \
  'allow 80/tcp comment fleet-dao http' \
  'allow 443/tcp comment fleet-dao https' \
  'allow 4500/udp comment fleet-dao wireguard' \
  'default deny incoming')"
check "这一遍不碰 8443" "$(grep -c 8443 "$FWDIR/log" || true)" 0
check "8443 仍是原来那一条" "$(grep -c $'^8443/tcp\tself-proxy$' "$FWDIR/rules")" 1
fresh
setup_firewall >"$FWDIR/out" 2>&1
RC=$?
check "补上入站之后第二遍返回 0" "$RC" 0
check "第二遍没有改动记录" "${#CHANGES[@]}" 0
check "第二遍没有改 ufw 的命令" "$(mutating)" ""
check "第二遍之后 8443 还在" "$(grep -c $'^8443/tcp\tself-proxy$' "$FWDIR/rules")" 1

echo "== 7b. 默认已经是拒绝、只有出站：仍要补入站，不能报已放行"
out_only_rules
set_ufw active 0 deny
good_ss
run_setup
check "返回 0" "$RC" 0
check "没有红" "${#REDS[@]}" 0
check "不报白名单都已放行" "$(grep -c '都已放行' <<<"$OUT" || true)" 0
check "只补四条入站，不再改默认" "$(mutating)" "$(printf '%s\n' \
  'allow 22/tcp comment fleet-dao ssh' \
  'allow 80/tcp comment fleet-dao http' \
  'allow 443/tcp comment fleet-dao https' \
  'allow 4500/udp comment fleet-dao wireguard')"
check "不删、不改 8443" "$(grep -c $'^8443/tcp\tself-proxy$' "$FWDIR/rules")" 1
check "日志里没有 8443" "$(grep -c 8443 "$FWDIR/log" || true)" 0

if ((fail)); then
  echo "hk-firewall：不通过"
  exit 1
fi
echo "hk-firewall：通过"
