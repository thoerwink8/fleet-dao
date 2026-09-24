#!/usr/bin/env bash
# 故意造违规样本，看 deploy/lib/root-exec-check.sh 能不能拦下；同时造几个不该拦的，看它会不会误报。
# 要 root：得造出属主不是 root 的文件。用法：sudo bash deploy/test/root-exec-check.test.sh
# 退出码：0 通过，1 不通过，2 没跑成（不是 root）。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/root-exec-check.sh
source "$HERE/../lib/root-exec-check.sh"

if ((EUID != 0)); then
  echo "没跑成：要 root（得造出属主不是 root 的文件）"
  exit 2
fi

# 沙盒放在 /run 下：它和它的上级都属 root、别人不可写，干净样本才可能判干净（/tmp 是谁都能写的）
T=$(mktemp -d /run/fleet-dao-rec-test.XXXXXX)
trap 'rm -rf -- "$T"' EXIT
chmod 755 "$T"
mkdir -p "$T/ok/bin" "$T/world" "$T/foreign" "$T/opendir" "$T/grpdir" "$T/logs" "$T/env"
printf '#!/bin/sh\n' >"$T/ok/bin/tool"
chmod 755 "$T/ok/bin/tool"
printf 'console.log(1)\n' >"$T/ok/app.mjs"
printf 'console.log(1)\n' >"$T/world/app.mjs"
chmod 666 "$T/world/app.mjs"
printf 'console.log(1)\n' >"$T/foreign/app.mjs"
chown nobody "$T/foreign/app.mjs"
cp "$T/ok/bin/tool" "$T/opendir/tool"
chmod 777 "$T/opendir"
cp "$T/ok/bin/tool" "$T/grpdir/x.sh"
chmod 775 "$T/grpdir"
ln -s "$T/world/app.mjs" "$T/link.sh"
printf 'log\n' >"$T/logs/data.log"
chmod 777 "$T/logs"
printf 'A=1\n' >"$T/env/bad.env"
chmod 666 "$T/env/bad.env"

exec_line() { # 属性名 程序 argv flags
  printf '%s={ path=%s ; argv[]=%s ; flags=%s ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n' "$1" "$2" "$3" "$4"
}
unit() { # 单元 LoadState User DynamicUser WorkingDirectory
  printf 'Id=%s\nLoadState=%s\nUser=%s\nDynamicUser=%s\nWorkingDirectory=%s\n' "$1" "$2" "$3" "$4" "$5"
}

SHOW=$T/show.txt
{
  # 该拦的
  unit world-writable-script.service loaded root no ""
  exec_line ExecStartEx /usr/bin/node "/usr/bin/node $T/world/app.mjs" ""
  echo
  unit foreign-owner.service loaded "" no ""
  exec_line ExecStartEx /usr/bin/node "/usr/bin/node --max-old-space-size=512 $T/foreign/app.mjs" ""
  echo
  unit open-parent.service loaded "" no ""
  exec_line ExecStartEx "$T/opendir/tool" "$T/opendir/tool" ""
  echo
  unit group-writable-dir.service loaded 0 no ""
  exec_line ExecStartEx /bin/sh "/bin/sh $T/grpdir/x.sh" ""
  echo
  unit missing-in-open-dir.service loaded "" no ""
  exec_line ExecStartPreEx /bin/sh "/bin/sh $T/opendir/not-yet.sh" ""
  echo
  unit symlink.service loaded "" no ""
  exec_line ExecStartEx /bin/bash "/bin/bash $T/link.sh" ""
  echo
  unit env.service loaded "" no ""
  echo "EnvironmentFiles=$T/env/bad.env (ignore_errors=no)"
  exec_line ExecStartEx "$T/ok/bin/tool" "$T/ok/bin/tool" ""
  echo
  unit workdir.service loaded "" no "$T/opendir"
  exec_line ExecStartEx "$T/ok/bin/tool" "$T/ok/bin/tool" ""
  echo
  unit privileged-in-nonroot.service loaded orca no ""
  exec_line ExecStartPreEx /usr/bin/node "/usr/bin/node $T/world/app.mjs" privileged
  exec_line ExecStartEx /usr/bin/node "/usr/bin/node $T/ok/app.mjs" ""
  echo
  # 不该拦的
  unit clean.service loaded "" no ""
  exec_line ExecStartEx "$T/ok/bin/tool" "$T/ok/bin/tool --config=$T/ok/app.mjs" ""
  echo
  unit data-arg.service loaded "" no ""
  exec_line ExecStartPreEx /usr/bin/savelog "/usr/bin/savelog -q $T/logs/data.log" ignore-failure
  echo
  unit nonroot.service loaded orca no ""
  exec_line ExecStartEx /usr/bin/node "/usr/bin/node $T/world/app.mjs" ""
  echo
  unit dynamic.service loaded "" yes ""
  exec_line ExecStartEx /usr/bin/node "/usr/bin/node $T/world/app.mjs" ""
  echo
  unit masked.service masked "" no ""
  exec_line ExecStartEx /usr/bin/node "/usr/bin/node $T/world/app.mjs" ""
} >"$SHOW"

export ROOT_EXEC_CHECK_SHOW=$SHOW
root_exec_check
rc=$?

want="env.service
foreign-owner.service
group-writable-dir.service
missing-in-open-dir.service
open-parent.service
privileged-in-nonroot.service
symlink.service
workdir.service
world-writable-script.service"
got=$(for v in "${REC_VIOLATIONS[@]}"; do printf '%s\n' "${v%%$'\t'*}"; done | sort -u)

if [[ "$got" == "$want" && "$rc" == 1 ]]; then
  echo "通过：$(wc -l <<<"$want") 个违规样本全部拦下，5 个干净样本没有误报"
  exit 0
fi
echo "不通过（root_exec_check 返回 $rc）。应拦 vs 实拦："
diff <(printf '%s\n' "$want") <(printf '%s\n' "$got")
printf '明细：\n'
printf '  %s\n' "${REC_VIOLATIONS[@]}"
exit 1
