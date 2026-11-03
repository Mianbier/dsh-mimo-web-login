@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo ==========================================
echo   MiMo 网页登录 · 端到端验证
echo ==========================================
echo.
echo 接下来会打开一个浏览器窗口（独立配置，不碰你日常的 Edge）。
echo 请在窗口里登录小米账号，登录成功并看到对话界面后，
echo 插件会自动读取凭据并关掉窗口。
echo.
pause

node test\e2e-login.mjs
set RESULT=%ERRORLEVEL%

echo.
if %RESULT%==0 (
  echo ✓ 端到端验证通过 —— 插件能真的连上 MiMo 并拿到回答。
) else (
  echo ✗ 验证失败，请把上面的输出发给我。
)
echo.
pause
endlocal
