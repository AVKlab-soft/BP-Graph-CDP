import type { HealthInfo } from "../types";

/* ============================================================
   Клиент моста СБОРКИ.
   prompt → POST /api/qwen → server.mjs / serve.ps1 →
   → powershell Provider_Qwen.ps1 -Action SendOnly → Qwen → ответ.
   Мост сам находит Provider_Qwen.ps1 относительно корня репозитория.
   ============================================================ */

const API = ""; // тот же хост, что и приложение

async function req<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(API + path, { ...init, signal: ctl.signal });
    const text = await res.text();
    let json: T;
    try {
      json = JSON.parse(text) as T;
    } catch {
      throw new Error(`Мост вернул не-JSON (HTTP ${res.status}). Запустите start.bat.`);
    }
    if (!res.ok) {
      const msg = (json as { error?: string })?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHealth(): Promise<HealthInfo> {
  try {
    return await req<HealthInfo>("/api/health", undefined, 2500);
  } catch {
    return { ok: false, bridge: "none", providerFound: false, transport: "CDP-transport" };
  }
}

export interface QwenReply {
  ok: boolean;
  answer?: string;
  error?: string;
  elapsedMs?: number;
}

/** Отправка prompt в Qwen через существующий CDP-transport. */
export async function sendToQwen(prompt: string, signal?: AbortSignal): Promise<QwenReply> {
  // Provider_Qwen.ps1 ждёт ответ до 300 c — даём мосту 330 c + запас
  const res = await fetch(API + "/api/qwen", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ prompt }),
    signal,
  });
  const data = (await res.json()) as QwenReply;
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Существующее действие Test провайдера: «Напиши одно слово: ТЕСТ.» */
export async function testQwen(): Promise<QwenReply> {
  return req<QwenReply>("/api/qwen/test", undefined, 340_000);
}

/** Существующее действие DeleteOnly: удалить текущий чат Qwen. */
export async function deleteChat(): Promise<{ ok: boolean; result?: string; error?: string }> {
  return req("/api/qwen/delete", undefined, 120_000);
}
