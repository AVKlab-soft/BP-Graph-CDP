#!/usr/bin/env node
/* ============================================================
   ЛОКАЛЬНЫЙ УЗЕЛ СБОРКИ (BPmanager × CDP-transport)

   1) отдаёт собранный редактор BPmanager (../dist);
   2) держит WebSocket-канал редактора (путь /sborka, тот же порт);
   3) ИСПОЛНЯЕТ граф: существующая модель nodes + edges —
      разветвление, сведение (ждёт все входы), циклы, MAX_STEPS;
   4) каждый промпт уходит в CDP-transport через Windows Named Pipe
      \\.\pipe\SborkaQwen — промпт и ответ живут в оперативной памяти,
      на диск (SSD) не пишутся, никакого HTTP/REST.

   Схема:  prompt → Named Pipe → IPC-адаптер → Provider_Qwen.ps1
           → Chrome CDP :9222 → Qwen → ответ → Named Pipe → сюда.
   ============================================================ */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // host/
const SBORKA = path.dirname(ROOT); // корень СБОРКИ

const PIPE_NAME = "\\\\.\\pipe\\SborkaQwen";
const PORT = Number(process.env.SBORKA_PORT) || 4398;
const MAX_STEPS = 1000;

/* папка со собранным редактором */
const DIST =
  [path.join(SBORKA, "dist"), path.join(SBORKA, "BPmanager", "dist")].find((p) =>
    fs.existsSync(path.join(p, "index.html")),
  ) || path.join(SBORKA, "dist");

/* провайдер Qwen (существующий, из CDP-transport) */
const PROVIDER = path.join(SBORKA, "CDP-transport", "Provider_Qwen.ps1");
const providerFound = fs.existsSync(PROVIDER);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/* ============================================================
   Named Pipe — клиент (транспорт к CDP-transport, всё в RAM)
   ============================================================ */
function callQwenViaPipe(prompt) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(PIPE_NAME, () => {
      client.write(JSON.stringify({ prompt }) + "\n");
    });
    let buf = "";
    client.on("data", (d) => {
      buf += d.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          client.end();
          if (msg.ok) resolve(msg.answer ?? "");
          else reject(new Error(msg.error || "Named Pipe вернул ошибку"));
          return;
        } catch {
          /* неполный JSON — ждём ещё */
        }
      }
    });
    client.on("error", (e) =>
      reject(new Error(`Named Pipe ${PIPE_NAME} недоступен (${e.message}). Запущен ли IPC-адаптер?`)),
    );
    client.setTimeout(330000, () => {
      client.destroy();
      reject(new Error("Таймаут ожидания ответа Qwen (330 с)"));
    });
  });
}

/* ============================================================
   ИСПОЛНИТЕЛЬ ГРАФА (порядок: порты существующего executor'а)
   ============================================================ */
function indexGraph(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map();
  const outgoing = new Map();
  nodes.forEach((n) => {
    incoming.set(n.id, new Set());
    outgoing.set(n.id, []);
  });
  const seen = new Set();
  const clean = [];
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const k = e.from + "→" + e.to;
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(e);
    incoming.get(e.to).add(e.from);
    outgoing.get(e.from).push(e.to);
  }
  return { incoming, outgoing, edges: clean };
}
function rootNodes(g) {
  const r = [];
  g.incoming.forEach((s, id) => {
    if (s.size === 0) r.push(id);
  });
  return r;
}
function isReady(g, id, latest) {
  const s = g.incoming.get(id);
  if (!s || s.size === 0) return true;
  for (const x of s) if (!latest.has(x)) return false;
  return true;
}
function findClosedCycles(g) {
  const roots = new Set(rootNodes(g));
  const reached = new Set(roots);
  const q = [...roots];
  while (q.length) {
    const id = q.shift();
    for (const n of g.outgoing.get(id) || []) if (!reached.has(n)) {
      reached.add(n);
      q.push(n);
    }
  }
  const closed = [];
  g.incoming.forEach((_, id) => {
    if (!reached.has(id)) closed.push(id);
  });
  return closed;
}
function buildPrompt(node, inputs, step) {
  const head = `УЗЕЛ: ${node.title}\nШАГ: ${step}`;
  const body = (node.content || "").trim() || "(содержимое узла пусто)";
  let parts = [head, "", "=== СОДЕРЖИМОЕ УЗЛА ===", body];
  if (inputs.length > 0) {
    parts = [...parts, "", "=== ВХОДНЫЕ РЕЗУЛЬТАТЫ ===", ...inputs.map((i) => `[${i.title}]:\n${i.result.trim()}`)];
  } else {
    parts = [...parts, "", "(стартовый узел — входных результатов нет)"];
  }
  return parts.join("\n");
}

async function runGraph(nodes, edges, maxSteps, send, emit, isAborted) {
  const g = indexGraph(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (nodes.length === 0) {
    emit({ type: "fail", message: "Граф пуст — нарисуйте хотя бы один узел." });
    return;
  }
  const closed = findClosedCycles(g);
  if (closed.length > 0) {
    emit({
      type: "fail",
      message: `Замкнутый цикл без входа: ${closed.map((id) => `«${byId.get(id)?.title || id}»`).join(", ")}. Добавьте узел-исток.`,
    });
    return;
  }
  const roots = rootNodes(g);
  if (roots.length === 0) {
    emit({ type: "fail", message: "Нет стартовых узлов: у каждого узла есть входящие связи." });
    return;
  }

  emit({
    type: "run-start",
    totalNodes: nodes.length,
    roots: roots.map((id) => ({ id, title: byId.get(id)?.title || id })),
    maxSteps,
  });

  const latest = new Map();
  const queue = [...roots];
  let steps = 0;
  const outEdgesOf = (id) => g.edges.filter((e) => e.from === id).map((e) => e.id);

  while (queue.length > 0) {
    if (isAborted()) {
      emit({ type: "stopped", steps });
      return;
    }
    const id = queue.shift();
    const node = byId.get(id);
    if (!node) continue;

    steps += 1;
    if (steps > maxSteps) {
      emit({ type: "step-limit", step: steps - 1, maxSteps });
      return;
    }

    emit({ type: "node-start", id, step: steps, title: node.title });

    const srcs = [...(g.incoming.get(id) || [])];
    const inputs = srcs.filter((s) => latest.has(s)).map((s) => ({ title: byId.get(s)?.title || s, result: latest.get(s) }));
    const prompt = buildPrompt(node, inputs, steps);
    emit({ type: "prompt", id, step: steps, prompt });

    const t0 = Date.now();
    let answer;
    try {
      answer = await send(prompt);
    } catch (e) {
      if (isAborted()) {
        emit({ type: "stopped", steps });
        return;
      }
      const msg = e?.message || String(e);
      emit({ type: "node-error", id, step: steps, title: node.title, error: msg });
      emit({ type: "fail", message: `Узел «${node.title}» не выполнен: ${msg}` });
      return;
    }
    if (isAborted()) {
      emit({ type: "stopped", steps });
      return;
    }

    latest.set(id, answer);
    emit({ type: "node-done", id, step: steps, title: node.title, answer, elapsedMs: Date.now() - t0, outEdges: outEdgesOf(id) });

    /* разветвление: всем исходящим; сведение: цель готова, когда готовы ВСЕ источники */
    for (const next of g.outgoing.get(id) || []) {
      if (!queue.includes(next) && isReady(g, next, latest)) queue.push(next);
    }
  }

  emit({ type: "done", steps });
}

/* ============================================================
   WebSocket-канал редактора (минимальный RFC6455, без зависимостей)
   ============================================================ */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const clients = new Set();
let abortFlag = false;

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}
function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }
  return { fin, opcode, payload, consumed: offset + len };
}
function sendTo(client, obj) {
  try {
    client.socket.write(encodeFrame(JSON.stringify(obj)));
  } catch {
    /* клиент мог отключиться */
  }
}
function broadcast(obj) {
  for (const c of clients) sendTo(c, obj);
}

function handleWs(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  );
  const client = { socket, buf: Buffer.alloc(0), frag: null };
  clients.add(client);
  sendTo(client, {
    type: "hello",
    providerFound,
    pipeName: PIPE_NAME,
    transport: "Named Pipe → CDP-transport → Qwen",
  });

  socket.on("data", (d) => {
    client.buf = Buffer.concat([client.buf, d]);
    for (;;) {
      const f = parseFrame(client.buf);
      if (!f) break;
      client.buf = client.buf.slice(f.consumed);
      if (f.opcode === 0x8) {
        clients.delete(client);
        try {
          socket.end();
        } catch {
          /* ignore */
        }
        return;
      }
      if (f.opcode === 0x9) {
        socket.write(Buffer.from([0x8a, 0x00])); // pong
        continue;
      }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        if (f.fin) onClientMessage(client, f.payload.toString("utf8"));
        else client.frag = { chunks: [f.payload] };
      } else if (f.opcode === 0x0 && client.frag) {
        client.frag.chunks.push(f.payload);
        if (f.fin) {
          onClientMessage(client, Buffer.concat(client.frag.chunks).toString("utf8"));
          client.frag = null;
        }
      }
    }
  });
  socket.on("close", () => clients.delete(client));
  socket.on("error", () => clients.delete(client));
}

async function onClientMessage(client, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.type === "run") {
    abortFlag = false;
    const nodes = Array.isArray(msg.nodes) ? msg.nodes : [];
    const edges = Array.isArray(msg.edges) ? msg.edges : [];
    const maxSteps = Number(msg.maxSteps) || MAX_STEPS;
    await runGraph(nodes, edges, maxSteps, callQwenViaPipe, broadcast, () => abortFlag);
  } else if (msg.type === "stop") {
    abortFlag = true;
  } else if (msg.type === "test") {
    try {
      const answer = await callQwenViaPipe("Напиши одно слово: ТЕСТ.");
      broadcast({ type: "test-result", ok: true, answer });
    } catch (e) {
      broadcast({ type: "test-result", ok: false, error: e?.message || String(e) });
    }
  }
}

/* ============================================================
   HTTP: только раздача редактора (никакого API) + upgrade на WS
   ============================================================ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(DIST, p));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const idx = path.join(DIST, "index.html");
  if (fs.existsSync(idx)) {
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    fs.createReadStream(idx).pipe(res);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Редактор не собран: отсутствует dist/index.html. Выполните npm run build один раз.");
  }
});

server.on("upgrade", (req, socket) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === "/sborka") handleWs(req, socket);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log("");
  console.log("  СБОРКА · локальный узел");
  console.log(`  Редактор:        http://127.0.0.1:${PORT}`);
  console.log(`  Named Pipe Qwen: ${PIPE_NAME}`);
  console.log(`  Провайдер:       ${providerFound ? PROVIDER : "НЕ НАЙДЕН (CDP-transport/Provider_Qwen.ps1)"}`);
  console.log("  (Ctrl+C — остановить)");
  console.log("");
});
