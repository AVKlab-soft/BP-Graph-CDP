/* ============================================================
   СБОРКА · BPmanager × CDP-transport
   Модель данных — существующая модель BPmanager: nodes + edges,
   документ хранится в data/<проект>/workspace.json,
   содержимое нод — в файлах <id>.md рядом с ним.
   ============================================================ */

export interface BPNode {
  id: string;
  title: string;
  x: number;
  y: number;
  /** содержимое ноды (текст задания для Qwen), хранится в <id>.md */
  content: string;
}

export interface BPEdge {
  id: string;
  from: string;
  to: string;
}

export interface WorkspaceDoc {
  name: string;
  updatedAt: number;
  nodes: BPNode[];
  edges: BPEdge[];
}

/* ---------- исполнение ---------- */

export const MAX_STEPS = 1000; // аварийный предел исполнителя

export type NodeRunStatus = "idle" | "queued" | "running" | "done" | "error" | "skipped";

export interface NodeRunInfo {
  status: NodeRunStatus;
  step?: number;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  /** сколько раз нода исполнялась за прогон (циклы) */
  execCount: number;
}

export type LogKind = "sys" | "prompt" | "answer" | "ok" | "err" | "step" | "warn";

export interface LogEntry {
  id: number;
  t: number;
  kind: LogKind;
  nodeId?: string;
  nodeTitle?: string;
  text: string;
  step?: number;
}

export type RunPhase = "idle" | "running" | "done" | "error" | "stopped";

export interface RunSummary {
  phase: RunPhase;
  steps: number;
  startedAt?: number;
  finishedAt?: number;
  message?: string;
}

/* ---------- транспорт ---------- */

/** статус канала редактор ↔ локальный узел (WebSocket) */
export type LinkStatus = "off" | "connecting" | "on";

export interface HealthInfo {
  /** узел СБОРКИ отвечает */
  ok: boolean;
  link: LinkStatus;
  /** Provider_Qwen.ps1 найден узлом рядом с собой */
  providerFound: boolean;
  /** имя Named Pipe, по которому промпт/ответ идут в CDP-transport */
  pipeName: string;
  transport: string;
}

/* ---------- константы нод на канвасе ---------- */

export const NODE_W = 208;
export const NODE_H = 96;

export const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

export const slug = (s: string): string => {
  const t = s
    .toLowerCase()
    .replace(/[а-яё]/gi, (c) => c)
    .replace(/[^a-zа-яё0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return t || "protsess";
};
