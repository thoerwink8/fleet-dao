#!/usr/bin/env bash
# #2138：监督机没有 ~/.ssh/fleet_login，经跳板拿别的钥匙登法国 root 会被公钥拒绝。
# 创始人登这台的公钥已经在 /etc/ssh/authorized_keys/<会话用户>（france.sh 从 pilot 抄来，root:root 644，会话用户写不了）。
# 发版（root）做两件，都不挡发版（调用方不看退出码，这里也总是返回 0）：
#   1. 把这些公钥补进 /root/.ssh/authorized_keys：没有才补，已有的行一个字不改、不删。
#   2. 写 sshd 的 Match User root（52-fleet-dao-root-login.conf），让 root 同时直接认那份会话口子。
#      抄进 authorized_keys 没写成、或 StrictModes 把那份丢掉时，root 仍认会话口子里的同一把。
# 不碰 authorized_keys2（发布钥匙），不把监督机的 grok_bot 提成 root（那把不在会话口子里）。
# 同时把 .ssh 收成 700、authorized_keys 收成 600，属主在 root 下跑时改成 root:root，否则 sshd StrictModes 整份不认。
# 值不进日志，只打补了几把和指纹。sshd -t 不过就撤掉刚写的 drop-in，不重载。
# 测试把 ROOT_SSH_LOGIN_SRC、ROOT_SSH_HOME、ROOT_SSH_LOGIN_DROPIN 指到临时目录。
# 真发版会先 unset 这几个和 ROOT_SSH_LOGIN_SSHD_T、ROOT_SSH_LOGIN_RELOAD，避免环境把路径指走。

root_ssh_login_src() {
  if [[ -n "${ROOT_SSH_LOGIN_SRC:-}" ]]; then
    printf '%s' "$ROOT_SSH_LOGIN_SRC"
    return 0
  fi
  printf '/etc/ssh/authorized_keys/%s' "${SESSION_USER:-fleet-agent-carpool}"
}

root_ssh_login_home() {
  if [[ -n "${ROOT_SSH_HOME:-}" ]]; then
    printf '%s' "$ROOT_SSH_HOME"
    return 0
  fi
  printf '/root'
}

# 一行公钥的 SHA256 指纹。认不出返回 1，不打钥匙本身。
root_ssh_login_fp() { # 一行
  local fp
  fp=$(printf '%s\n' "$1" | ssh-keygen -lf - 2>/dev/null | awk 'NR==1 { print $2 }') || return 1
  [[ "$fp" == SHA256:* ]] || return 1
  printf '%s' "$fp"
}

# 文件里每把认得出的公钥，指纹一行一个。文件没有、读不了，输出为空、返回 0。
# 行首是选项（restrict、command=）的不认：原样留在文件里，不当成已经有这把。
root_ssh_login_fps() { # 文件
  local line fp
  [[ -f "$1" && ! -L "$1" && -r "$1" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == ssh-* || "$line" == ecdsa-sha2-* || "$line" == sk-* ]] || continue
    fp=$(root_ssh_login_fp "$line") || continue
    printf '%s\n' "$fp"
  done <"$1" || return 0
}

# 非空且末字节不是换行时补一个换行，避免下一把粘到上一行末尾。
# 命令替换会吃掉结尾的换行，所以在末字节后面垫一个 x 再剥掉。
root_ssh_login_ensure_nl() { # 文件
  local last
  [[ -s "$1" ]] || return 0
  last=$({ tail -c 1 -- "$1" && printf x; }) || return 1
  last=${last%x}
  if [[ "$last" != $'\n' ]]; then
    printf '\n' >>"$1"
  fi
}

# 目录 700、钥匙文件 600。符号链接不跟着走。缺了就跳过。root 下跑时属主改成 root:root。
root_ssh_login_repair_modes() { # .ssh 目录、authorized_keys
  if [[ -d "$1" && ! -L "$1" ]]; then
    chmod 700 -- "$1" || true
    if ((EUID == 0)); then
      chown root:root -- "$1" || true
    fi
  fi
  if [[ -f "$2" && ! -L "$2" ]]; then
    chmod 600 -- "$2" || true
    if ((EUID == 0)); then
      chown root:root -- "$2" || true
    fi
  fi
}

root_ssh_login_modes_line() { # .ssh 目录、authorized_keys
  local sm am
  [[ -d "$1" && ! -L "$1" && -f "$2" && ! -L "$2" ]] || return 0
  sm=$(stat -c '%a' -- "$1" 2>/dev/null) || return 0
  am=$(stat -c '%a' -- "$2" 2>/dev/null) || return 0
  printf '  ✓ root 登录：%s 权限 %s、%s 权限 %s\n' "$1" "$sm" "$2" "$am"
}

# 写到一半失败：临时文件删掉；这次新建的空 .ssh 也撤掉，原来的文件一个字节不动。
root_ssh_login_abort() { # 临时文件、是不是这次新建的目录、.ssh 目录、说明
  if [[ -n "$1" ]]; then
    rm -f -- "$1"
  fi
  if [[ "$2" == 1 ]]; then
    rmdir -- "$3" 2>/dev/null || true
  fi
  printf '  - root 登录：%s，没改\n' "$4"
}

ensure_root_login_keys() {
  local src home ssh ak have="" line fp seen=0 added=0 created_ssh=0 tmp i new_fps=""
  local -a add_lines=()
  local -a add_fps=()
  src=$(root_ssh_login_src)
  home=$(root_ssh_login_home)
  ssh=$home/.ssh
  ak=$ssh/authorized_keys
  if [[ -L "$src" ]]; then
    printf '  - root 登录：会话口子 %s 是符号链接，没改\n' "$src"
    return 0
  fi
  if [[ ! -f "$src" || ! -r "$src" ]]; then
    printf '  - root 登录：没有会话口子 %s，没改 root 的 authorized_keys\n' "$src"
    return 0
  fi
  if [[ -L "$ssh" || (-e "$ssh" && ! -d "$ssh") ]]; then
    printf '  - root 登录：%s 不是目录，没改\n' "$ssh"
    return 0
  fi
  if [[ -L "$ak" || (-e "$ak" && ! -f "$ak") ]]; then
    printf '  - root 登录：%s 不是普通文件，没改\n' "$ak"
    return 0
  fi
  if [[ -f "$ak" && ! -r "$ak" ]]; then
    printf '  - root 登录：读不了 %s，没改\n' "$ak"
    return 0
  fi
  if [[ -f "$ak" ]]; then
    have=$(root_ssh_login_fps "$ak" | sort -u) || have=""
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == ssh-* || "$line" == ecdsa-sha2-* || "$line" == sk-* ]] || continue
    fp=$(root_ssh_login_fp "$line") || continue
    seen=$((seen + 1))
    if [[ -n "$have" ]] && printf '%s\n' "$have" | grep -qxF -- "$fp"; then
      continue
    fi
    add_lines+=("$line")
    add_fps+=("$fp")
    have=$(printf '%s\n%s\n' "$have" "$fp" | sed '/^$/d' | sort -u)
  done <"$src"
  added=${#add_lines[@]}
  if ((added == 0)); then
    root_ssh_login_repair_modes "$ssh" "$ak"
    if ((seen == 0)); then
      printf '  ✓ root 登录：会话口子里没有认得出的公钥，没补\n'
    else
      printf '  ✓ root 登录：会话口子里的公钥 root 都已有，没新补\n'
    fi
    root_ssh_login_modes_line "$ssh" "$ak"
    return 0
  fi
  if [[ ! -d "$ssh" ]]; then
    if ! mkdir -p -- "$ssh"; then
      printf '  - root 登录：建不了 %s，没改\n' "$ssh"
      return 0
    fi
    created_ssh=1
  fi
  # 先收目录权限，再把公钥写进去，避免钥匙落在 755 目录里。
  chmod 700 -- "$ssh" || true
  tmp=$(mktemp "$ssh/.authorized_keys.XXXXXX") || {
    root_ssh_login_abort "" "$created_ssh" "$ssh" "在 ${ssh} 里建不了临时文件"
    return 0
  }
  if [[ -f "$ak" ]]; then
    if ! cat -- "$ak" >"$tmp"; then
      root_ssh_login_abort "$tmp" "$created_ssh" "$ssh" "读不了 ${ak}"
      return 0
    fi
  fi
  if ! root_ssh_login_ensure_nl "$tmp"; then
    root_ssh_login_abort "$tmp" "$created_ssh" "$ssh" "补不了换行"
    return 0
  fi
  for i in "${!add_lines[@]}"; do
    if ! printf '%s\n' "${add_lines[$i]}" >>"$tmp"; then
      root_ssh_login_abort "$tmp" "$created_ssh" "$ssh" "写不进临时文件"
      return 0
    fi
  done
  if ! chmod 600 -- "$tmp"; then
    root_ssh_login_abort "$tmp" "$created_ssh" "$ssh" "改不了临时文件权限"
    return 0
  fi
  if ((EUID == 0)); then
    chown root:root -- "$tmp" || true
  fi
  if ! mv -f -- "$tmp" "$ak"; then
    root_ssh_login_abort "$tmp" "$created_ssh" "$ssh" "换不上 ${ak}"
    return 0
  fi
  root_ssh_login_repair_modes "$ssh" "$ak"
  new_fps="${add_fps[*]}"
  printf '  ✓ root 登录：从会话口子补进 %d 把公钥（%s），原有的行没删\n' "$added" "$new_fps"
  root_ssh_login_modes_line "$ssh" "$ak"
  return 0
}

# drop-in 默认放这里。52 排在 51（会话用户的 Match）后面；各自在自己的文件里结束，不漏到别的用户。
root_ssh_login_dropin() {
  if [[ -n "${ROOT_SSH_LOGIN_DROPIN:-}" ]]; then
    printf '%s' "$ROOT_SSH_LOGIN_DROPIN"
    return 0
  fi
  printf '/etc/ssh/sshd_config.d/52-fleet-dao-root-login.conf'
}

# 路径只许绝对路径、由这些字符组成，且没有 ..。不合规矩的不能写进 sshd 配置。
root_ssh_login_path_ok() { # 路径
  [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ "$1" != *..* ]] || return 1
}

# Match User root 的那一份。钥匙文件路径由调用方保证过 root_ssh_login_path_ok。
root_ssh_login_dropin_text() { # 钥匙文件
  printf '%s\n' \
    '# deploy/lib/root-ssh-login.sh 写的（发版、退回）。别在机器上手改：下次发版按这份重写。' \
    '# root 同时认自己家里的 authorized_keys、authorized_keys2，和会话口子里的公钥。' \
    '# 会话口子 root:root 644，会话用户写不了。不改口令登录。Match 到本文件末尾为止，不漏到别的用户。' \
    'Match User root' \
    "	AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 $1"
}

root_ssh_login_sshd_check() {
  if [[ -n "${ROOT_SSH_LOGIN_SSHD_T:-}" ]]; then
    bash -c "$ROOT_SSH_LOGIN_SSHD_T"
    return
  fi
  sshd -t
}

root_ssh_login_sshd_reload() {
  if [[ -n "${ROOT_SSH_LOGIN_RELOAD:-}" ]]; then
    bash -c "$ROOT_SSH_LOGIN_RELOAD"
    return
  fi
  systemctl reload ssh.service
}

# 让 root 直接认会话口子。文件没变不重载。sshd -t 不过就还原，不重载。写不了、验不了都不挡发版。
ensure_root_login_sshd() {
  local keys dropin dir text old="" have_old=0 tmp err
  # 补钥匙的测试把家目录指走、不设 drop-in：别去动这台机器的 sshd。
  if [[ -n "${ROOT_SSH_LOGIN_HOME:-}" && -z "${ROOT_SSH_LOGIN_DROPIN:-}" ]]; then
    return 0
  fi
  keys=$(root_ssh_login_src)
  dropin=$(root_ssh_login_dropin)
  if ! root_ssh_login_path_ok "$keys"; then
    printf '  - root 登录：会话口子路径不能写进 sshd 配置，没改 sshd\n'
    return 0
  fi
  if ! root_ssh_login_path_ok "$dropin"; then
    printf '  - root 登录：drop-in 路径不合规矩，没改 sshd\n'
    return 0
  fi
  dir=${dropin%/*}
  if [[ ! -d "$dir" || -L "$dir" ]]; then
    printf '  - root 登录：%s 不是目录，没改 sshd\n' "$dir"
    return 0
  fi
  if [[ -L "$dropin" || (-e "$dropin" && ! -f "$dropin") ]]; then
    printf '  - root 登录：%s 不是普通文件，没改 sshd\n' "$dropin"
    return 0
  fi
  text=$(root_ssh_login_dropin_text "$keys")
  if [[ -f "$dropin" && ! -r "$dropin" ]]; then
    printf '  - root 登录：读不了 %s，没改 sshd\n' "$dropin"
    return 0
  fi
  if [[ -f "$dropin" ]]; then
    old=$(<"$dropin") || old=""
    have_old=1
  fi
  if ((have_old)) && [[ "$old" == "$text" ]]; then
    printf '  ✓ root 登录：sshd 已让 root 认会话口子，没改\n'
    return 0
  fi
  tmp=$(mktemp "$dir/.52-fleet-dao-root-login.XXXXXX") || {
    printf '  - root 登录：在 %s 里建不了临时文件，没改 sshd\n' "$dir"
    return 0
  }
  if ! printf '%s\n' "$text" >"$tmp"; then
    rm -f -- "$tmp"
    printf '  - root 登录：写不进临时文件，没改 sshd\n'
    return 0
  fi
  chmod 644 -- "$tmp" || true
  if ((EUID == 0)); then
    chown root:root -- "$tmp" || true
  fi
  if ! mv -f -- "$tmp" "$dropin"; then
    rm -f -- "$tmp"
    printf '  - root 登录：换不上 %s，没改 sshd\n' "$dropin"
    return 0
  fi
  if ! err=$(root_ssh_login_sshd_check 2>&1); then
    if ((have_old)); then
      printf '%s\n' "$old" >"$dropin" || true
    else
      rm -f -- "$dropin"
    fi
    printf '  - root 登录：加上 drop-in 之后 sshd -t 不过，已撤掉，没重载：%s\n' "${err:0:200}"
    return 0
  fi
  if ! err=$(root_ssh_login_sshd_reload 2>&1); then
    printf '  - root 登录：sshd -t 过了，但重载没成（文件已放好，下次 ssh 重启生效）：%s\n' "${err:0:200}"
    return 0
  fi
  printf '  ✓ root 登录：sshd 让 root 同时认会话口子，已重载\n'
  return 0
}
