# CDP_Core.ps1
# Ядро взаимодействия с браузером через Chrome DevTools Protocol (CDP)
# Работает на чистом .NET (System.Net.WebSockets) без сторонних библиотек.
# Реализует логику "реального клика" и ожидания стабильности контента.
#
# Класс CDPSession реализует контракт, который вызывает Provider_Qwen.ps1:
#   Connect / EvaluateJS / SendKey / WaitForStableText /
#   RealMouseMove / RealClick / Dispose
# Чтение ответов CDP — синхронное (события без id игнорируются),
# что надёжнее фоновых джобов при последовательных вызовах провайдера.

class CDPSession {
    [System.Net.WebSockets.ClientWebSocket] $Socket
    [string] $WsUrl
    [int] $MessageId = 0

    # Конструктор по умолчанию — подключение через Connect()
    CDPSession() {
        $this.Socket = New-Object System.Net.WebSockets.ClientWebSocket
        $this.Socket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(15)
    }

    # Подключение по WebSocket URL вкладки (webSocketDebuggerUrl)
    [bool] Connect([string] $wsUrl) {
        try {
            $this.WsUrl = $wsUrl
            $uri = New-Object System.Uri $wsUrl
            $task = $this.Socket.ConnectAsync($uri, [System.Threading.CancellationToken]::None)
            $task.Wait()
            if ($this.Socket.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
                Write-Host "CDP: не удалось открыть сокет: $wsUrl" -ForegroundColor Red
                return $false
            }
            return $true
        } catch {
            Write-Host "CDP: ошибка подключения: $_" -ForegroundColor Red
            return $false
        }
    }

    # Отправка команды CDP и синхронное ожидание ответа с тем же id
    [pscustomobject] Send([string] $method, [hashtable] $params) {
        $this.MessageId++
        $id = $this.MessageId

        $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 12 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $segment = [System.ArraySegment[byte]]::new($bytes)
        $this.Socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()

        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
            $msg = $this.ReceiveMessage()
            if ($null -eq $msg) { continue }
            if ($msg.id -eq $id) {
                if ($msg.error) {
                    throw "CDP Error ($method): $($msg.error.message)"
                }
                return $msg.result
            }
            # события и чужие id — игнорируем
        }
        throw "Таймаут ожидания ответа от CDP для метода: $method"
    }

    # Синхронное чтение одного полного JSON-сообщения
    [pscustomobject] ReceiveMessage() {
        $ms = New-Object System.IO.MemoryStream
        $buffer = New-Object byte[] 65536
        do {
            $segment = [System.ArraySegment[byte]]::new($buffer)
            $result = $this.Socket.ReceiveAsync($segment, [System.Threading.CancellationToken]::None).Result
            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
            $ms.Write($buffer, 0, $result.Count)
        } while (-not $result.EndOfMessage)
        $jsonStr = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
        $ms.Dispose()
        try { return ($jsonStr | ConvertFrom-Json) } catch { return $null }
    }

    # Выполнение JS на странице, значение возвращается напрямую (returnByValue)
    [object] EvaluateJS([string] $expression) {
        $result = $this.Send("Runtime.evaluate", @{
            expression = $expression
            returnByValue = $true
        })
        if ($result.exceptionDetails) {
            return "ERR_JS: $($result.exceptionDetails.text)"
        }
        return $result.result.value
    }

    # Нажатие клавиши (Enter и т.п.) — keyDown + keyUp
    [void] SendKey([string] $key) {
        $map = @{
            Enter = @{ key = "Enter"; code = "Enter"; keyCode = 13 }
            Tab   = @{ key = "Tab"; code = "Tab"; keyCode = 9 }
        }
        $k = $map[$key]
        if (-not $k) { $k = @{ key = $key; code = $key; keyCode = 0 } }

        $this.Send("Input.dispatchKeyEvent", @{
            type = "rawKeyDown"
            key = $k.key
            code = $k.code
            windowsVirtualKeyCode = $k.keyCode
            nativeVirtualKeyCode = $k.keyCode
        }) | Out-Null
        Start-Sleep -Milliseconds 60
        $this.Send("Input.dispatchKeyEvent", @{
            type = "keyUp"
            key = $k.key
            code = $k.code
            windowsVirtualKeyCode = $k.keyCode
            nativeVirtualKeyCode = $k.keyCode
        }) | Out-Null
    }

    # Ожидание появления текста и его стабилизации.
    # Берётся ПОСЛЕДНИЙ элемент по селектору (в чате это свежий ответ),
    # текст считается готовым после stableChecks подряд неизменных чтений.
    [string] WaitForStableText([string] $containerSelector, [int] $timeoutSec = 60, [int] $stableChecks = 3) {
        $deadline = (Get-Date).AddSeconds($timeoutSec)
        $prevText = ""
        $stableCount = 0

        $script = @"
(function() {
    var els = document.querySelectorAll('$containerSelector');
    if (!els.length) return '';
    var el = els[els.length - 1];
    return (el.innerText || '').trim();
})()
"@
        Start-Sleep -Seconds 2 # даём чату вставить контейнер нового ответа

        while ((Get-Date) -lt $deadline) {
            $currentText = [string]$this.EvaluateJS($script)

            if ($currentText -ne $prevText) {
                $prevText = $currentText
                $stableCount = 0
            } else {
                $stableCount++
            }

            if ($currentText -and $stableCount -ge $stableChecks) {
                return $currentText
            }
            Start-Sleep -Seconds 2
        }

        if ($prevText) { return $prevText }
        return ""
    }

    # Движение мыши (эмуляция через CDP)
    [void] RealMouseMove([int] $x, [int] $y) {
        $this.Send("Input.dispatchMouseEvent", @{
            type = "mouseMoved"
            x = $x
            y = $y
            button = "none"
            pointerType = "mouse"
        }) | Out-Null
    }

    # Реальный клик мышью (эмуляция событий мыши)
    # Критично для Ant Design и сложных UI, где .click() не работает
    [void] RealClick([int] $x, [int] $y) {
        $this.RealMouseMove($x, $y)
        Start-Sleep -Milliseconds 200

        $this.Send("Input.dispatchMouseEvent", @{
            type = "mousePressed"
            x = $x
            y = $y
            button = "left"
            clickCount = 1
            pointerType = "mouse"
        }) | Out-Null
        Start-Sleep -Milliseconds 150

        $this.Send("Input.dispatchMouseEvent", @{
            type = "mouseReleased"
            x = $x
            y = $y
            button = "left"
            clickCount = 1
            pointerType = "mouse"
        }) | Out-Null
    }

    # Закрытие соединения
    [void] Dispose() {
        try {
            if ($this.Socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
                $this.Socket.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "Closing", [System.Threading.CancellationToken]::None).Wait(2000)
            }
        } catch { }
        $this.Socket.Dispose()
    }
}

# Вспомогательная функция для получения списка вкладок и поиска нужной
function Get-CDPTab {
    param([string] $FilterUrl)

    $response = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json" -TimeoutSec 5
    foreach ($tab in $response) {
        if ($tab.url -like "*$FilterUrl*") {
            return $tab
        }
    }
    return $null
}

# Пример использования (закомментирован):
# $tab = Get-CDPTab -FilterUrl "chat.qwen.ai"
# if ($tab) {
#     $session = New-Object CDPSession
#     if ($session.Connect($tab.webSocketDebuggerUrl)) {
#         $session.RealClick(100, 100)
#         $session.Dispose()
#     }
# }
