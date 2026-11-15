@echo off
setlocal
cd /d "%~dp0"

set "PORT=8123"
if not "%~1"=="" set "PORT=%~1"

rem 便携包自带 node\node.exe；开发目录里没有时退回系统 PATH 里的 node
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 未找到 node\node.exe，本机也没有安装 Node.js
    pause
    exit /b 1
  )
  set "NODE=node"
)

echo 启动 MapStitch: http://localhost:%PORT%/  （关闭本窗口即退出服务）
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%/"

"%NODE%" src\cli.js serve --port %PORT%
if errorlevel 1 (
  echo.
  echo 启动失败（端口被占用？换一个端口试试: start.bat 8125）
  pause
)
endlocal
