#!/usr/bin/env node
/* ============================================================
   МИНИМАЛЬНЫЙ IPC-АДАПТЕР СБОРКИ

   Единственная задача: связать исполнителя BPmanager с СУЩЕСТВУЮЩИМ
   CDP-transport через Windows Named Pipe, без файлов и без HTTP.

     получить строку из Named Pipe  (\\.\pipe\SborkaQwen)
        ↓
     передать её существующему Provider_Qwen.ps1 (-Action SendOnly)
        ↓
     получить ответ (stdout провайдера, в RAM)
        ↓
     передать ответ обратно через Named Pipe

   Промпт и ответ находятся только в оперативной памяти — на SSD
   ничего не пишется. Сам Provider_Qwen.ps1 не меняется: он по-прежнему
   «получил текст → отправил в Qwen через CDP :9222 → вернул текст».
   Меняется лишь способ получения входа и возврата результата.

   Протокол трубы: построчный JSON (JSON.stringify экранирует переводы
   строк, поэтому каждый объект занимает ровно одну строку).
     клиент → адаптер:  {"prompt":"…"}\n
     адаптер → клиент:  {"ok":true,"answer":"…"}\n  или  {"ok":false,"error":"…"}\n
   ============================================================ */
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // ipc/
const SBORKA = path.dirname(ROOT); // корень СБОРКИ
const PIPE_NAME = "\\\\.\\pipe\\SborkaQwen";

/* существующий провайдер — ищем автоматически относительно корня СБОРКИ */
const PROVIDER = path.join(SBORKA, "CDP-transport", "Provider_Qwen.ps1");
if (!fs.existsSync(PROVIDER)) {
  console.error(`ОШИБКА: не найден ${PROVIDER}`);
  process.exit(1);
}

/* Вызов существующего Provider_Qwen.ps1.
   Промпт передаём через STDIN (не через аргумент командной строки —
   нет ограничений на длину и проблем с кавычками/переводами строк).
   6>$null гасит Write-Host-прогресс, чтобы в stdout остался только ответ
   (Write-Output), который мы и возвращаем по трубе. */
function callProvider(prompt) {
  return new Promise((resolve, reject) => {
    const providerEscaped = PROVIDER.replace(/'/g, "''");
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ` +
          `$m=[Console]::In.ReadToEnd(); ` +
          `& '${providerEscaped}' -Action SendOnly -MessageText $m 6>$null`,
      ],
      { windowsHide: true },
    );
    let out = "";
    let err = "";
    ps.stdout.on("data", (d) => (out += d.toString("utf8")));
    ps.stderr.on("data", (d) => (err += d.toString("utf8")));
    ps.on("error", (e) => reject(new Error(`Не удалось запустить powershell: ${e.message}`)));
    ps.on("close", (code) => {
      const answer = out.replace(/^\uFEFF/, "").trim();
      if (answer) return resolve(answer);
      reject(
        new Error(
          err.trim() ||
            (code === 0
              ? "Provider_Qwen не вернул ответ. Проверьте вкладку chat.qwen.ai в браузере (порт 9222)."
              : `Provider_Qwen завершился с кодом ${code}. Проверьте браузер с Qwen.`),
        ),
      );
    });
    ps.stdin.on("error", () => {});
    ps.stdin.write(prompt, "utf8");
    ps.stdin.end();
  });
}

/* Named Pipe — сервер. Данные живут в RAM, на диск не попадают. */
const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", async (d) => {
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let prompt = "";
      try {
        prompt = String(JSON.parse(line).prompt ?? "");
      } catch {
        continue;
      }
      if (!prompt) {
        socket.write(JSON.stringify({ ok: false, error: "Пустой промпт" }) + "\n");
        continue;
      }
      try {
        const answer = await callProvider(prompt);
        socket.write(JSON.stringify({ ok: true, answer }) + "\n");
      } catch (e) {
        socket.write(JSON.stringify({ ok: false, error: e.message || String(e) }) + "\n");
      }
    }
  });
  socket.on("error", () => {});
});

server.on("error", (e) => {
  console.error(`ОШИБКА Named Pipe ${PIPE_NAME}: ${e.message}`);
  process.exit(1);
});

server.listen(PIPE_NAME, () => {
  console.log("");
  console.log("  СБОРКА · IPC-адаптер Qwen");
  console.log(`  Named Pipe: ${PIPE_NAME}`);
  console.log(`  Провайдер:  ${PROVIDER}`);
  console.log("  (Ctrl+C — остановить)");
  console.log("");
});
