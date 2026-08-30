import type { WorkspaceDoc } from "../types";
import { slug } from "../types";

/* ============================================================
   Хранение: сначала пробуем сервер СБОРКИ (data/<проект>/),
   если мост не запущен — localStorage (локальный режим).
   Формат — существующий: workspace.json + <id>.md на узел.
   ============================================================ */

const LS_KEY = "sborka:workspace";
const LS_MODE_KEY = "sborka:mode";

export type SaveMode = "server" | "local";

export interface SaveResult {
  mode: SaveMode;
  dataPath?: string;
}

export async function saveDoc(doc: WorkspaceDoc): Promise<SaveResult> {
  const id = slug(doc.name) + "-" + Math.abs(hashCode(doc.name)).toString(36);
  const files = [
    { name: "workspace.json", content: JSON.stringify(doc, null, 2) },
    ...doc.nodes.map((n) => ({ name: `${n.id}.md`, content: n.content })),
  ];
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ files }),
    });
    if (res.ok) {
      const j = (await res.json()) as { dataPath?: string };
      localStorage.setItem(LS_MODE_KEY, "server");
      return { mode: "server", dataPath: j.dataPath };
    }
    throw new Error("server");
  } catch {
    localStorage.setItem(LS_KEY, JSON.stringify(doc));
    localStorage.setItem(LS_MODE_KEY, "local");
    return { mode: "local" };
  }
}

export async function loadDoc(): Promise<{ doc: WorkspaceDoc | null; mode: SaveMode }> {
  try {
    const res = await fetch("/api/projects");
    if (res.ok) {
      const j = (await res.json()) as { projects: { id: string; updatedAt: number }[] };
      const latest = j.projects[0];
      if (latest) {
        const r2 = await fetch(`/api/projects/${encodeURIComponent(latest.id)}`);
        if (r2.ok) {
          const doc = (await r2.json()) as WorkspaceDoc;
          // содержимое нод сервер отдаёт внутри workspace.json (мы его туда пишем)
          return { doc: normalize(doc), mode: "server" };
        }
      }
      return { doc: null, mode: "server" };
    }
    throw new Error("server");
  } catch {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      try {
        return { doc: normalize(JSON.parse(raw) as WorkspaceDoc), mode: "local" };
      } catch {
        /* повреждено — начнём заново */
      }
    }
    return { doc: null, mode: "local" };
  }
}

function normalize(doc: WorkspaceDoc): WorkspaceDoc {
  return {
    name: doc.name || "Без названия",
    updatedAt: doc.updatedAt || Date.now(),
    nodes: Array.isArray(doc.nodes) ? doc.nodes : [],
    edges: Array.isArray(doc.edges) ? doc.edges : [],
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/* ---------- примеры схем (для проверки из ТЗ) ---------- */

export function sampleLinear(): WorkspaceDoc {
  const now = Date.now();
  return {
    name: "Пример: цепочка A → B → C",
    updatedAt: now,
    nodes: [
      {
        id: "node-a",
        title: "A · Идея",
        x: 90,
        y: 220,
        content:
          "Придумай одну короткую продуктовую идею для мобильного приложения. Опиши её одним абзацем (3–4 предложения).",
      },
      {
        id: "node-b",
        title: "B · Критика",
        x: 400,
        y: 220,
        content:
          "Покритикуй полученную идею: найди 2 слабых места и предложи, как их усилить. Ответ — кратко, по пунктам.",
      },
      {
        id: "node-c",
        title: "C · Итог",
        x: 710,
        y: 220,
        content:
          "Собери финальную версию идеи с учётом критики. Итог — один связный абзац и название продукта.",
      },
    ],
    edges: [
      { id: "e-ab", from: "node-a", to: "node-b" },
      { id: "e-bc", from: "node-b", to: "node-c" },
    ],
  };
}

export function sampleDiamond(): WorkspaceDoc {
  const now = Date.now();
  return {
    name: "Пример: ветвление и сведение",
    updatedAt: now,
    nodes: [
      {
        id: "n-a",
        title: "A · Тема",
        x: 80,
        y: 240,
        content: "Сформулируй тему: «Экскурсия по городу за 3 часа». Опиши целевую аудиторию одним предложением.",
      },
      {
        id: "n-b",
        title: "B · Маршрут",
        x: 390,
        y: 120,
        content: "Составь пешеходный маршрут на 3 часа по теме: 4 точки с временем в каждой. Кратко, списком.",
      },
      {
        id: "n-c",
        title: "C · Риски",
        x: 390,
        y: 360,
        content: "Перечисли 3 риска этой экскурсии (погода, толпа, усталость) и по одной контрмере. Кратко.",
      },
      {
        id: "n-d",
        title: "D · Сводка",
        x: 710,
        y: 240,
        content:
          "Объедини маршрут и риски в итоговый план экскурсии: сначала маршрут, затем блок «что учесть». Связный текст.",
      },
    ],
    edges: [
      { id: "e1", from: "n-a", to: "n-b" },
      { id: "e2", from: "n-a", to: "n-c" },
      { id: "e3", from: "n-b", to: "n-d" },
      { id: "e4", from: "n-c", to: "n-d" },
    ],
  };
}

export function sampleCycle(): WorkspaceDoc {
  const now = Date.now();
  return {
    name: "Пример: цикл A → B → C → B",
    updatedAt: now,
    nodes: [
      {
        id: "c-a",
        title: "A · Затравка",
        x: 90,
        y: 220,
        content: "Напиши первую строку короткого рассказа (одно предложение, интригующее).",
      },
      {
        id: "c-b",
        title: "B · Продолжение",
        x: 400,
        y: 220,
        content:
          "Продолжи рассказ РОВНО одним предложением, опираясь на входные результаты. Затем добавь строку «СТОП», если сюжет логично завершён, иначе строку «ДАЛЬШЕ».",
      },
      {
        id: "c-c",
        title: "C · Проверка",
        x: 710,
        y: 220,
        content:
          "Прочитай последнее предложение рассказа. Если рассказ длиннее 4 предложений — ответь «СТОП». Иначе передай текст дальше без изменений.",
      },
    ],
    edges: [
      { id: "ce1", from: "c-a", to: "c-b" },
      { id: "ce2", from: "c-b", to: "c-c" },
      { id: "ce3", from: "c-c", to: "c-b" },
    ],
  };
}
