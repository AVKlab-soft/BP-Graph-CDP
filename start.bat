@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title СБОРКА · BPmanager x CDP-transport

echo.
echo   ============================================================
echo    СБОРКА  ·  BPmanager x CDP-transport  (Named Pipe, RAM)
echo   ============================================================
echo.

rem --- 1) IPC-адаптер: Named Pipe \\.\pipe\SborkaQwen -> Provider_Qwen.ps1
echo   [1/2] IPC-адаптер Qwen (Named Pipe)...
start "Sborka IPC Adapter" /min node "%~dp0ipc\qwen-ipc-adapter.mjs"

rem --- 2) Локальный узел: редактор + исполнитель + клиент Named Pipe
echo   [2/2] Локальный узел (редактор + исполнитель)...
start "Sborka Host" node "%~dp0host\sborka-host.mjs"

timeout /t 2 /nobreak >nul

start "" "http://127.0.0.1:4398"

echo.
echo   Готово. Редактор открыт:  http://127.0.0.1:4398
echo.
echo   Как это работает:
echo     ИСПОЛНИТЬ -^> промпт -^> \\.\pipe\SborkaQwen (оперативная память)
echo                 -^> Provider_Qwen.ps1 -^> Chrome CDP :9222 -^> Qwen
echo                 -^> ответ -^> \\.\pipe\SborkaQwen -^> следующая нода
echo.
echo   Промпт и ответ НЕ пишутся на диск и НЕ идут по HTTP.
echo   Chrome с открытой вкладкой chat.qwen.ai (порт 9222) должен быть запущен.
echo.
echo   Закройте окна "Sborka Host" и "Sborka IPC Adapter", чтобы остановить.
echo.
pause
