@echo off
rem ============================================================
rem  DeverAI Harness 启动器(fork + 模型自动路由)
rem  - 使用 all_projects 下的源码副本(dsh-harness-fork)
rem  - DEVERAI_ROUTER=1 激活 @deverai/model-router
rem  - 关闭本窗口即退出;官方启动器行为不受影响
rem  用法: start-deverai.cmd [额外的 dsh web 参数]
rem        例: start-deverai.cmd --port 3080
rem ============================================================
setlocal
set "DEVERAI_ROUTER=1"
set "FORK=%USERPROFILE%\Documents\all_projects\dsh-harness-fork"
if not exist "%FORK%\lib\bin.js" (
  echo [start-deverai] fork not found: %FORK%
  pause
  exit /b 1
)
echo [start-deverai] launching fork harness with model router...
node "%FORK%\lib\bin.js" web %*
endlocal
