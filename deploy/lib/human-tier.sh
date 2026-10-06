#!/usr/bin/env bash
# shellcheck disable=SC2154 # SESSION_USERS、PILOT_USER、RECLAUDE_*、AGENT_SCOPE_BIN 这些由 france.sh 在前面设好，这里只用
# 装机的「人工档」：碰防火墙、sudoers、建用户、改机器上的钥匙和环境文件的那些步骤，只在人以 root 跑整个 deploy/france.sh 时做。
# 其余（自动发布脚本副本、systemd 单元文件、fleet-agents.slice、演示版可见范围的单元）是「自动档」，由自动发布每发完一版顺带跑
# bash deploy/france.sh --auto-tier（docs/ops.md 第九节「装机层」）。
# 为什么单独成一个文件：后端的 /healthz（deploy_lag）只在人工档这几个文件自上次装机后真变了才标「装机脚本落后、要人重跑」，
# 判法是 git log <装到的提交>..<主线> -- <这几个文件>（deploy/france/auto-release/lib.mjs 的 HUMAN_TIER_PATHS）；
# 人工档的函数要是写在 france.sh 里，改它们和改自动档就分不出来了。改这里之前必须知道：
# - 新加一个碰防火墙、sudoers、建用户的步骤，放这里，用到的仓里文件写进 HUMAN_TIER_PATHS（auto-release.test.mjs 核对：
#   这里引用的每个仓里文件都被盖住）；
# - 自动档的函数（setup_slice、setup_demo_scopes、setup_auto_release）留在 france.sh，不许碰防火墙、sudoers、建用户。
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
  ensure_dir "$DEMO_DIR" fleet:fleet 750
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
