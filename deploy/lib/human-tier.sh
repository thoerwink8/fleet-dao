#!/usr/bin/env bash
# shellcheck disable=SC2154 # SESSION_USERS、PILOT_USER、RECLAUDE_*、AGENT_SCOPE_BIN 这些由 france.sh 在前面设好，这里只用
# 装机的「人工档」：碰防火墙、sudoers、建用户、改机器上的钥匙和环境文件的那些步骤，只在人以 root 跑整个 deploy/france.sh 时做。
# 其余（自动发布脚本副本、systemd 单元文件、fleet-agents.slice）是「自动档」，由自动发布每发完一版顺带跑
# bash deploy/france.sh --auto-tier（docs/ops.md 第九节「装机层」）。
# 为什么单独成一个文件：后端的 /healthz（deploy_lag）只在人工档这几个文件自上次装机后真变了才标「装机脚本落后、要人重跑」，
# 判法是 git log <装到的提交>..<主线> -- <这几个文件>（deploy/france/auto-release/lib.mjs 的 HUMAN_TIER_PATHS）；
# 人工档的函数要是写在 france.sh 里，改它们和改自动档就分不出来了。改这里之前必须知道：
# - 新加一个碰防火墙、sudoers、建用户的步骤，放这里，用到的仓里文件写进 HUMAN_TIER_PATHS（auto-release.test.mjs 核对：
#   这里引用的每个仓里文件都被盖住）；
# - 自动档的函数（setup_slice、setup_auto_release）留在 france.sh，不许碰防火墙、sudoers、建用户。
# 要先 source common.sh，用到的变量和函数由 france.sh 设。

setup_identity() {
  step "用户与目录"
  ensure_service_user fleet /home/fleet
  ensure_dir /home/fleet fleet:fleet 750
  # 代码归 root、fleet 只读：以 fleet 身份跑的 AI 会话改不了引擎自己的代码。/srv/fleet-dao 是装机脚本所在的检出，
  # 应用的各版在 /srv/fleet-dao-releases（发布脚本建，构建完才换成 root 的）
  ensure_dir /srv/fleet-dao root:root 755
  ensure_dir "$RELEASES_DIR" root:root 755
  ensure_dir /var/lib/fleet-dao fleet:fleet 750
  # 引擎自己的临时目录（从镜像打的 bundle）和存档（没合并就收的树里没提交的改动）放在这下面，引擎自己建 tmp/、archive/
  ensure_dir "$ENGINE_STATE_DIR" fleet:fleet 750
  ensure_dir "$SESSION_IO_DIR" fleet:fleet 711
  # AI 会话的工作树的根：归 root、别人写不进（会话用户没法在路径上塞符号链接）；每棵树由 fleet-agent-scope 建、归会话用户 700
  ensure_dir "$WORK_DIR" root:root 755
  ensure_dir /var/log/fleet-dao fleet:fleet 750
  ensure_dir /etc/fleet-dao root:fleet 750
  # 两个 GitHub 机器人的私钥放这里（root:fleet 640，手放，不进 git）：引擎读得到，会话用户和旧系统的用户读不到
  ensure_dir /etc/fleet-dao/github root:fleet 750
  ensure_dir /opt/fleet-dao root:root 755
  local u
  ensure_pkgs curl # 下会话用户的 reclaude 要它
  for u in "${SESSION_USERS[@]}"; do
    ensure_service_user "$u" "/home/$u"
    ensure_dir "/home/$u" "$u:$u" 750
    # 引擎起 Claude 会话用的就是它家里这份 reclaude（engine.env 的 {user} 路径）：新机器上没有就装，登录仍由人做（ops 第五节）
    ensure_user_reclaude "$u" "/home/$u" "https://dl.reclaude.ai/$RECLAUDE_VERSION/reclaude-linux-amd64" "$RECLAUDE_SHA256"
  done
  if [[ -e "$ENV_FILE" ]]; then
    fix_meta "$ENV_FILE" root:fleet 640
  else
    put_file "$ENV_FILE" root:fleet 640 "$(<"$DEPLOY_DIR/france/france.env.example")"
  fi
}

setup_pilot() {
  step "创始人的登录用户 $PILOT_USER（经 Mirasim 的 ssh 远程模式登进来；没有 sudo，看得了日志）"
  # Mirasim 桌面端连进来时在它家里自己装服务端（~/.mirasim-remote，自带 node）：这头要 curl 直接下服务端包
  # （下不了由桌面端经 scp 传）、tar 和 gzip 解包（Ubuntu 必装的包）；干活要 git 和 ssh 客户端
  ensure_pkgs git openssh-client curl
  setup_login_user "$PILOT_USER" "$PILOT_HOME" "https://dl.reclaude.ai/$RECLAUDE_VERSION/reclaude-linux-amd64" "$RECLAUDE_SHA256"
}

setup_sudoers() {
  step "引擎起会话的脚本与 sudoers（只放行 fleet-agent-scope 这一个）"
  # 引擎（fleet）自己建不了系统级 scope，会话还得换成会话用户：给它一个只做这件事的 root 脚本，sudoers 只放行这一个。
  # polkit 管不窄——systemd 255 建临时单元时不把单元名交给 polkit，放行就等于放行任何单元、任何身份。
  put_file "$AGENT_SCOPE_BIN" root:root 755 "$(<"$DEPLOY_DIR/france/fleet-agent-scope.sh")"
  local tmp
  tmp=$(mktemp)
  cp -- "$DEPLOY_DIR/france/sudoers-fleet-dao" "$tmp"
  # sudoers 写坏了会把 sudo 整个弄瘫：先单独验这一份，过了才放进去
  if ! visudo -cqf "$tmp" >/dev/null 2>&1; then
    rm -f -- "$tmp"
    red "deploy/france/sudoers-fleet-dao 过不了 visudo -c，不装"
    return 1
  fi
  rm -f -- "$tmp"
  put_file "$SUDOERS_FILE" root:root 440 "$(<"$DEPLOY_DIR/france/sudoers-fleet-dao")"
  if ! visudo -cq >/dev/null 2>&1; then
    rm -f -- "$SUDOERS_FILE"
    red "放进 $SUDOERS_FILE 之后整套 sudoers 验不过，已撤回"
    return 1
  fi
}

# fleet-dao.nft 渲染好的样子放进 RENDERED：setup_firewall 装的就是它，读回拿它比文件。uid 都现查，查不到判红、不往下写
render_firewall() {
  local ports fleet_uid session_uid
  # 模板里挡会话口的规则只写得下一个会话用户（fleet-dao.nft 第二道隔离末尾写了为什么）
  if ((${#SESSION_USERS[@]} != 1)); then
    red "会话用户有 ${#SESSION_USERS[@]} 个，deploy/france/fleet-dao.nft 挡会话口的规则只写得下一个：先改规则"
    return 1
  fi
  if ! fleet_uid=$(id -u fleet 2>/dev/null) || ! session_uid=$(id -u "${SESSION_USERS[0]}" 2>/dev/null); then
    red "查不到 fleet 或 ${SESSION_USERS[0]} 的 uid：nft 表写不出来"
    return 1
  fi
  ports=$(printf '%s, ' "${PROTECTED_PORTS[@]}")
  render "$DEPLOY_DIR/france/fleet-dao.nft" PORTS="${ports%, }" FLEET_UID="$fleet_uid" SESSION_UID="$session_uid"
}

setup_firewall() {
  step "防火墙（隧道上放行香港访问驾驶舱后端；本机上 Temporal、库、后端只许 root 和 fleet 连；会话用户在本机开的口只许它自己连）"
  # 驾驶舱后端的端口只对隧道那头的香港开：规则挂在隧道网卡上，公网照旧一个入站端口都不开
  local rule="allow in on $WG_IF from $WG_HK_ADDR to ${WG_ADDR%/*} port $API_PORT proto tcp" tmp err file_changed unit_changed
  if command -v ufw >/dev/null && [[ "$(ufw status 2>/dev/null | head -1)" == "Status: active" ]]; then
    if [[ "$(ufw show added 2>/dev/null)" == *"ufw $rule"* ]]; then
      ok "ufw 已有：$rule"
    else
      # shellcheck disable=SC2086 # 规则按词拆开传给 ufw
      ufw $rule comment 'fleet-dao cockpit api over wireguard' >/dev/null
      changed "ufw $rule"
    fi
  else
    ok "这台没开 ufw，隧道上不用另外放行"
  fi
  # 本机上谁能连 Temporal、库、驾驶舱后端：只许 root 和 fleet（按连接发起方的属主），会话用户连上去就被复位；
  # 会话用户在回环上开的口（它的 reclaude 代理）只许它自己和 root 连（按应答方的属主，#35）
  render_firewall
  tmp=$(mktemp)
  printf '%s\n' "$RENDERED" >"$tmp"
  # 规则写错了载不进去：先验这一份，过了才放上去
  if ! err=$(nft -c -f "$tmp" 2>&1); then
    rm -f -- "$tmp"
    red "deploy/france/fleet-dao.nft 渲染后过不了 nft -c：$(head -3 <<<"$err" | tr '\n' ' ')"
    return 1
  fi
  rm -f -- "$tmp"
  put_file "$NFT_FILE" root:fleet 640 "$RENDERED"
  file_changed=$WROTE
  put_file /etc/systemd/system/fleet-firewall.service root:root 644 "$(<"$DEPLOY_DIR/france/fleet-firewall.service")"
  unit_changed=$WROTE
  if ((unit_changed)); then systemctl daemon-reload; fi
  if [[ "$(systemctl is-active fleet-firewall.service 2>/dev/null)" == active ]] && ((file_changed || unit_changed)); then
    # 表是在一个事务里删了重建的，reload 不会有空窗；restart 会先删表，中间有一小段谁都能连
    systemctl reload fleet-firewall.service
    changed "重载 fleet-firewall（nft 表换成新规则）"
  fi
  ensure_unit_running fleet-firewall.service 0
  # 规则只管新连接：表载上之前就连着会话用户的口、由别人发起的连接在这里断掉（lib/session-ports.sh）
  session_ports_cut "${SESSION_USERS[0]}"
}

# sshd 抗扫描（人工档，#1348）：法国 sshd 的 drop-in。为什么是人工档：它改的是登录入口，配错了连 root 都登不上来（和 sudoers、防火墙一个性质），
# 要人以 root 整套跑一次、看着结论；装法跟 deploy/backup/install.sh 的 setup_hk_sshd 一样：放文件 → sshd -t → 过了才 reload，
# 不过就把这份撤掉、不重载、判红。reload 不断已登录的连接。内容和为什么这么配见 deploy/france/sshd-hardening.conf。
setup_sshd_hardening() {
  step "sshd 抗扫描（$SSHD_HARDENING_DROPIN：未认证只等 20 秒、未认证连接槽 30:30:120、每条连接最多错 3 次；不改端口和认证方式）"
  local err
  if ! command -v sshd >/dev/null; then
    red "这台没有 sshd 命令：抗扫描配置没法验，不装"
    return 1
  fi
  if [[ ! -d "${SSHD_HARDENING_DROPIN%/*}" ]]; then
    red "${SSHD_HARDENING_DROPIN%/*} 不是目录：这台的 sshd 不是按 sshd_config.d 的写法配的，不装"
    return 1
  fi
  put_file "$SSHD_HARDENING_DROPIN" root:root 644 "$(<"$DEPLOY_DIR/france/sshd-hardening.conf")"
  if ((WROTE == 0)); then return 0; fi
  # 先验整份配置：不过就撤掉这份、不重载——sshd 配错了，下一次重启就没人登得上来
  if ! err=$(sshd -t 2>&1); then
    rm -f -- "$SSHD_HARDENING_DROPIN"
    red "加上 $SSHD_HARDENING_DROPIN 之后 sshd -t 不过，已撤掉、没重载：${err:0:300}"
    return 1
  fi
  if ! err=$(systemctl reload ssh.service 2>&1); then
    red "sshd -t 过了，但 systemctl reload ssh.service 没成（配置文件已放好，下次 sshd 重启生效）：${err:0:300}"
    return 1
  fi
  changed "重载 sshd（已登录的连接不受影响）"
}

# 读回：文件和仓里一样；sshd 的有效配置（sshd -T，不看文件，看真生效的）这三项就是要的值——被别处的配置抢先盖掉会在这里判红
readback_sshd_hardening() {
  local cfg spec key got
  if [[ "$(cat -- "$SSHD_HARDENING_DROPIN" 2>/dev/null)" != "$(<"$DEPLOY_DIR/france/sshd-hardening.conf")" ]]; then
    red "$SSHD_HARDENING_DROPIN 不在或和仓里 deploy/france/sshd-hardening.conf 不一样：重跑 france.sh"
  fi
  if ! cfg=$(sshd -T 2>&1); then
    red "sshd -T 读不出有效配置，抗扫描三项没核对：${cfg:0:200}"
    return 0
  fi
  for spec in "logingracetime 20" "maxstartups 30:30:120" "maxauthtries 3"; do
    key=${spec%% *}
    got=$(awk -v k="$key" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }' <<<"$cfg")
    if [[ "$got" == "${spec#* }" ]]; then
      ok "sshd 有效配置 $key = $got"
    else
      red "sshd 有效配置 $key = 「${got:-没读到}」，应为 ${spec#* }（被别的配置文件盖了，或没重载）"
    fi
  done
}

# 会话用户的登录口子收口（人工档，#1785）。为什么是人工档：改的是 sshd 的认证入口（Match User 配错了会影响别的用户登录）、
# 动的是会话用户家里的钥匙，和 sshd 抗扫描、建用户一个性质，要人以 root 整套跑一次、看着结论。三步：
#   1. 会话用户家里的 ~/.ssh 有任何东西，整个挪到 /root/quarantine/<用户>-ssh-<日期>/（只挪不删，记 changed）；
#   2. /etc/ssh/authorized_keys/<用户>（root:root 644，目录 root:root 755）照 pilot 家里的 authorized_keys 写；
#   3. sshd 的 Match User drop-in（deploy/france/sshd-session-user.conf）把它认钥匙的文件指到上一步那份：sshd -t 过了才 reload，
#      不过就撤掉这份、不重载、判红。
# 为什么不是把 ~/.ssh 改归 root:<用户>（750/640）：StrictModes 认 root 属主，这样 sshd 肯认；但家目录归会话用户、它有写权限，
# 能把 root 属主的 ~/.ssh 整个改名挪开再建一个自己的，拦不住。认钥匙的文件放到它写不到的 /etc 下才收得住。
setup_session_ssh() {
  local u=${SESSION_USERS[0]} keys err old have_old
  step "会话用户 $u 的登录口子（~/.ssh 挪到 $SESSION_QUARANTINE_ROOT；钥匙放 $SESSION_SSH_KEYS_DIR/$u；sshd 的 Match User 段指过去）"
  if ! command -v sshd >/dev/null; then
    red "这台没有 sshd 命令：会话用户的 Match User 段没法验，不装"
    return 1
  fi
  if [[ ! -d "${SSHD_SESSION_USER_DROPIN%/*}" ]]; then
    red "${SSHD_SESSION_USER_DROPIN%/*} 不是目录：这台的 sshd 不是按 sshd_config.d 的写法配的，不装"
    return 1
  fi
  ensure_dir "$SESSION_SSH_KEYS_DIR" root:root 755 || return 1
  # 钥匙文件先于 drop-in 放好；pilot 那份读不到就不写，已有的不动，红由读回再报一次（会话用户登不进来，不是漏洞）
  if keys=$(cat -- "$SESSION_SSH_ALLOW_FILE" 2>/dev/null) && [[ -n "$keys" ]]; then
    put_file "$SESSION_SSH_KEYS_DIR/$u" root:root 644 "$keys"
  else
    red "$SESSION_SSH_ALLOW_FILE 读不到或是空的：$SESSION_SSH_KEYS_DIR/$u 没写，桌面端连不进 $u"
  fi
  render "$DEPLOY_DIR/france/sshd-session-user.conf" SESSION_USER="$u" KEYS_DIR="$SESSION_SSH_KEYS_DIR" || return 1
  # 先读旧版：sshd -t 不过时有旧版就还原旧版，没有才删
  old=""
  have_old=0
  if [[ -f "$SSHD_SESSION_USER_DROPIN" ]]; then
    old=$(<"$SSHD_SESSION_USER_DROPIN")
    have_old=1
  fi
  put_file "$SSHD_SESSION_USER_DROPIN" root:root 644 "$RENDERED"
  if ((WROTE == 0)); then
    # drop-in 没变（已装好、已重载过）：Match 段在生效，可以挪家里的 ~/.ssh
    quarantine_session_ssh "$u" "$SESSION_USER_HOME_ROOT/$u" || true
    return 0
  fi
  # 挪 ~/.ssh 放在 drop-in 装好、sshd -t 过、reload 成功之后：之前的顺序下 sshd -t 不过或 reload 不成，
  # 家里的口子没了、/etc 下的口子又没生效，会话用户（桌面端要连它）就被锁在外面
  if ! err=$(sshd -t 2>&1); then
    if ((have_old)); then
      put_file "$SSHD_SESSION_USER_DROPIN" root:root 644 "$old"
    else
      rm -f -- "$SSHD_SESSION_USER_DROPIN"
    fi
    red "加上 $SSHD_SESSION_USER_DROPIN 之后 sshd -t 不过，已撤掉（有旧版则还原）、没重载、~/.ssh 没挪：${err:0:300}"
    return 1
  fi
  if ! err=$(systemctl reload ssh.service 2>&1); then
    red "sshd -t 过了，但 systemctl reload ssh.service 没成（配置文件已放好，下次 sshd 重启生效；~/.ssh 没挪，重跑 france.sh）：${err:0:300}"
    return 1
  fi
  changed "重载 sshd（已登录的连接不受影响）"
  quarantine_session_ssh "$u" "$SESSION_USER_HOME_ROOT/$u" || true
}

# 读回：drop-in 和渲染后的仓里一样；sshd 的有效配置（sshd -T -C user=…，看真生效的）里，会话用户认钥匙的文件是
# /etc/ssh/authorized_keys/<用户>，pilot 的不是（Match 段没漏到别的用户）。钥匙文件和 ~/.ssh 的核对在 readback_session_user
readback_session_ssh_scope() {
  local u=${SESSION_USERS[0]} who cfg got
  render "$DEPLOY_DIR/france/sshd-session-user.conf" SESSION_USER="$u" KEYS_DIR="$SESSION_SSH_KEYS_DIR" || return 0
  if [[ "$(cat -- "$SSHD_SESSION_USER_DROPIN" 2>/dev/null)" != "$RENDERED" ]]; then
    red "$SSHD_SESSION_USER_DROPIN 不在或和仓里 deploy/france/sshd-session-user.conf 不一样：重跑 france.sh"
  fi
  for who in "$u" "$PILOT_USER"; do
    if ! cfg=$(sshd -T -C "user=$who,host=localhost,addr=127.0.0.1,laddr=127.0.0.1,lport=22" 2>&1); then
      red "sshd -T -C user=$who 读不出有效配置，$who 认钥匙的文件没核对：${cfg:0:200}"
      continue
    fi
    got=$(awk '$1 == "authorizedkeysfile" { $1 = ""; sub(/^ /, ""); print; exit }' <<<"$cfg")
    if [[ "$who" == "$u" ]]; then
      if [[ "$got" == "$SESSION_SSH_KEYS_DIR/%u" || "$got" == "$SESSION_SSH_KEYS_DIR/$u" ]]; then
        ok "sshd 有效配置：$u 认钥匙的文件是 $got（不看它家里的 ~/.ssh）"
      else
        red "sshd 有效配置：$u 认钥匙的文件是「${got:-没读到}」，应为 $SESSION_SSH_KEYS_DIR/%u（Match 段没生效或被盖了，它家里的 authorized_keys 还认）"
      fi
    elif [[ -z "$got" ]]; then
      red "sshd 有效配置：$who 认钥匙的文件没读到，Match 段有没有漏到别的用户没核对成"
    elif [[ "$got" == *"$SESSION_SSH_KEYS_DIR"* ]]; then
      red "sshd 有效配置：$who 认钥匙的文件也成了「$got」：Match 段漏到了别的用户，他的 ~/.ssh/authorized_keys 不认了"
    else
      ok "sshd 有效配置：$who 认钥匙的文件还是「$got」，Match 段只管 $u"
    fi
  done
}

# fail2ban 的 sshd jail（人工档，#1348）：装法同上，先 fail2ban-client -t 验、过了才放着并 reload，不过就撤掉这份、判红。
# 没装 fail2ban 只记待配，不装软件包（装包是另一件事）。内容和为什么见 deploy/france/fail2ban-sshd.jail。
# 参数：jail 文件在仓里的路径（默认法国这份；香港 hk.sh 传 deploy/hk/fail2ban-sshd.jail，装到同名的 $FAIL2BAN_SSHD_JAIL）
setup_fail2ban_sshd() {
  local src=${1:-$DEPLOY_DIR/france/fail2ban-sshd.jail}
  step "fail2ban 的 sshd jail（$FAIL2BAN_SSHD_JAIL：3 次失败封 1 小时、反复来的越封越长；没装 fail2ban 就只记待配，不装软件包）"
  local err
  if ! command -v fail2ban-client >/dev/null; then
    pending "这台没装 fail2ban（没有 fail2ban-client）：sshd 的封禁配置没放，装好后再跑一遍装机脚本"
    return 0
  fi
  if [[ ! -d "${FAIL2BAN_SSHD_JAIL%/*}" ]]; then
    red "${FAIL2BAN_SSHD_JAIL%/*} 不是目录：fail2ban 装了但没有 jail.d，不放"
    return 1
  fi
  put_file "$FAIL2BAN_SSHD_JAIL" root:root 644 "$(<"$src")"
  if ((WROTE == 0)); then return 0; fi
  if ! err=$(fail2ban-client -t 2>&1); then
    rm -f -- "$FAIL2BAN_SSHD_JAIL"
    red "放上 $FAIL2BAN_SSHD_JAIL 之后 fail2ban-client -t 不过，已撤掉、没重载：${err:0:300}"
    return 1
  fi
  if [[ "$(systemctl is-active fail2ban.service 2>/dev/null)" != active ]]; then
    pending "fail2ban.service 没在跑：$FAIL2BAN_SSHD_JAIL 已放好，它起来时会读到；起来后再跑一遍装机脚本读回"
    return 0
  fi
  if ! err=$(fail2ban-client reload 2>&1); then
    red "fail2ban-client reload 没成（$FAIL2BAN_SSHD_JAIL 已放好，-t 是过的）：${err:0:300}"
    return 1
  fi
  changed "fail2ban-client reload"
}

# 读回：文件和仓里一样；在跑的 sshd jail 四项（maxretry、findtime、bantime、bantime.increment）就是要的值。
# 没装、没在跑是待配；jail 不在（enabled 没生效）和值不对是红；fail2ban-client 自己答不出的也是待配，不当成对了
# 参数：jail 文件在仓里的路径（默认法国这份）；可选第二个参数：ignoreip 里必须有的一段（香港传 10.99.0.0/24，没有判红）
readback_fail2ban_sshd() {
  local src=${1:-$DEPLOY_DIR/france/fail2ban-sshd.jail} want_ignore=${2:-} spec key got want rc
  if ! command -v fail2ban-client >/dev/null; then
    pending "没装 fail2ban：sshd 的封禁（maxretry 3、封 1 小时）没查"
    return 0
  fi
  if [[ "$(cat -- "$FAIL2BAN_SSHD_JAIL" 2>/dev/null)" != "$(<"$src")" ]]; then
    red "$FAIL2BAN_SSHD_JAIL 不在或和仓里 deploy/${src#"$DEPLOY_DIR"/} 不一样：重跑装机脚本"
  fi
  if [[ "$(systemctl is-active fail2ban.service 2>/dev/null)" != active ]]; then
    pending "fail2ban.service 没在跑：sshd jail 的有效值没查"
    return 0
  fi
  if ! got=$(fail2ban-client status sshd 2>&1); then
    red "fail2ban 里没有在跑的 sshd jail（enabled = true 没生效？）：${got:0:200}"
    return 0
  fi
  for spec in "maxretry 3" "findtime 600" "bantime 3600" "bantime.increment true"; do
    key=${spec%% *}
    want=${spec#* }
    rc=0
    got=$(fail2ban-client get sshd "$key" 2>&1) || rc=$?
    got=$(tr -d '[:space:]' <<<"$got")
    got=${got,,}
    if ((rc != 0)); then
      pending "fail2ban-client get sshd $key 没答出来，没核对：${got:0:120}"
    elif [[ "$got" == "$want" ]]; then
      ok "fail2ban sshd jail $key = $got"
    else
      red "fail2ban sshd jail $key = 「${got:-没读到}」，应为 $want（被别的 jail 配置盖了，或没 reload）"
    fi
  done
  if [[ -n "$want_ignore" ]]; then
    rc=0
    got=$(fail2ban-client get sshd ignoreip 2>&1) || rc=$?
    if ((rc != 0)); then
      pending "fail2ban-client get sshd ignoreip 没答出来，没核对：${got:0:120}"
    elif [[ "$got" == *"$want_ignore"* ]]; then
      ok "fail2ban sshd jail ignoreip 含 $want_ignore"
    else
      red "fail2ban sshd jail ignoreip 里没有 $want_ignore（读到「$(tr '\n' ' ' <<<"$got" | cut -c1-120)」）：这段地址的失败登录会被封"
    fi
  fi
}

# 驾驶舱「发布到法国」按钮的接活（人工档，不在自动档里）：驾驶舱后端（fleet，没有 root）往 $RELEASE_REQUEST_DIR 写一份请求文件，
# root 的 fleet-release-request.path 盯着它、起 fleet-release-request.service 走一趟发版（核请求、暂停、等收尾、release.sh、验证、发完保持关）。
# 为什么是人工档：这是一个由 fleet 写的文件触发 root 跑发布的口子，装它等于给「驾驶舱上点一下就能让 root 发版」开了路，要创始人在法国自己跑一次整套 france.sh。
# 接活脚本把请求只当数据读（认不出的、提交号不对的、不是主线祖先的、CI 不绿的、已有发版在走的一律拒），进度写在 root 的 $TRAIN_DIR（fleet 写不进）。
# 要在 setup_auto_release 之后装：接活脚本用同级的 ../auto-release/lib.mjs 判 CI。
setup_release_request() {
  step "驾驶舱「发布到法国」按钮的接活（请求目录 $RELEASE_REQUEST_DIR 归 fleet，进度目录 $TRAIN_DIR 归 root；root 的 path 单元接活）"
  local f u unit_changed=0
  ensure_dir "$RELEASE_REQUEST_DIR" fleet:fleet 750
  ensure_dir "$TRAIN_DIR" root:root 755
  ensure_dir /usr/local/lib/fleet-dao root:root 755
  ensure_dir "$RELEASE_REQUEST_LIB" root:root 755
  for f in "${RELEASE_REQUEST_FILES[@]}"; do
    put_file "$RELEASE_REQUEST_LIB/$f" root:root 644 "$(<"$DEPLOY_DIR/france/release-request/$f")"
  done
  for u in "${RELEASE_REQUEST_UNITS[@]}"; do
    put_file "/etc/systemd/system/$u" root:root 644 "$(<"$DEPLOY_DIR/france/$u")"
    if ((WROTE)); then unit_changed=1; fi
  done
  if ((unit_changed)); then systemctl daemon-reload; fi
  ensure_unit_running fleet-release-request.path "$unit_changed"
}

# 读回：path 单元在等、副本和仓里一样、请求目录和进度目录的属主权限对（驾驶舱按「单元文件在不在」判装没装，所以这里一项不对都判红）
readback_release_request() {
  local f u spec path want have bad=0
  if [[ "$(systemctl is-active fleet-release-request.path 2>/dev/null)" != active ]]; then
    red "fleet-release-request.path 没在跑：驾驶舱上点「发布到法国」不会有人接"
  fi
  for f in "${RELEASE_REQUEST_FILES[@]}"; do
    if ! cmp -s -- "$RELEASE_REQUEST_LIB/$f" "$DEPLOY_DIR/france/release-request/$f"; then
      red "$RELEASE_REQUEST_LIB/$f 和仓里的不一样（或没装）：重跑本脚本"
    fi
  done
  for u in "${RELEASE_REQUEST_UNITS[@]}"; do
    if ! cmp -s -- "/etc/systemd/system/$u" "$DEPLOY_DIR/france/$u"; then red "/etc/systemd/system/$u 和仓里的不一样（或没装）：重跑本脚本"; fi
  done
  for spec in "$RELEASE_REQUEST_DIR fleet:fleet 750" "$TRAIN_DIR root:root 755" "$RELEASE_REQUEST_LIB root:root 755"; do
    path=${spec%% *}
    want=${spec#* }
    have=$(stat -c '%U:%G %a' -- "$path" 2>/dev/null) || have="不存在"
    if [[ "$have" != "$want" ]]; then
      red "$path 是「$have」，应为 $want"
      bad=1
    fi
  done
  if ((bad == 0)); then ok "发布请求的目录和接活脚本的属主、权限都对"; fi
}
