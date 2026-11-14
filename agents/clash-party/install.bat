@echo off
rem 一键装 Clash Party 的 agy 覆写并切到规则模式。需要本机有 Node 22+ 和 pnpm，先在仓里 pnpm install 过。
rem 等价于：pnpm clash-party install
cd /d "%~dp0\..\.."
call pnpm clash-party install %*
if errorlevel 1 (
  echo 没装成，看上面的报错。
  pause
  exit /b 1
)
pause
