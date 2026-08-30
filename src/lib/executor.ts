import { MAX_STEPS, type BPNode, type WorkspaceDoc } from "../types";
import { findClosedCycles, indexGraph, isReady, rootNodes } from "./graph";

/* ============================================================
   ИСПОЛНИТЕЛЬ

   входные результаты + содержимое ноды → prompt
        → существующий CDP-transport (Provider_Qwen.ps1) → Qwen
        → ответ → результат ноды → следующим нодам по edges.

   Разветвление: результат A уходит всем исходящим рёбрам.
   Сведение: D исполняется после результатов ВСЕХ входящих нод,
             в prompt D передаются результаты всех входящих.
   Циклы: разрешены; повторный вход исполняет ноду заново.
          Аварийный предел — MAX_STEPS = 1000.
   ============================================================ */

export interface ExecutorHooks {
  onStart(totalNodes: number, roots: string[]): void;
  onQueue(nodeIds: string[]): void;
  onNodeStart(nodeId: string, step: number): void;
  onPrompt(nodeId: string, prompt: string, step: number): void;
  onNodeDone(nodeId: string, answer: string, step: number, elapsedMs: number): void;
  onNodeError(nodeId: string, error: string, step: number): void;
  onStepLimit(step: number): void;
  onDone(steps: number, results: Map<string, string>): void;
  onFail(message: string): void;
  isAborted(): boolean;
}

export interface SendFn {
  (prompt: string): Promise<string>;
}

export function buildPrompt(
  node: BPNode,
  inputs: { title: string; result: string }[],
  step: number,
): string {
  const head = [`УЗЕЛ: ${node.title}`, `ШАГ: ${step}`].join("\n");
  const body = node.content.trim() || "(содержимое узла пусто)";
  let parts = [head, "", "=== СОДЕРЖИМОЕ УЗЛА ===", body];
  if (inputs.length > 0) {
    parts = [
      ...parts,
      "",
      "=== ВХОДНЫЕ РЕЗУЛЬТАТЫ ===",
      ...inputs.map(({ title, result }) => `[${title}]:\n${result.trim()}`),
    ];
  } else {
    parts = [...parts, "", "(стартовый узел — входных результатов нет)"];
  }
  return parts.join("\n");
}

export async function runGraph(doc: WorkspaceDoc, send: SendFn, h: ExecutorHooks): Promise<void> {
  const g = indexGraph(doc.nodes, doc.edges);
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));

  if (doc.nodes.length === 0) {
    h.onFail("Граф пуст — нарисуйте хотя бы один узел.");
    return;
  }

  const closed = findClosedCycles(g);
  if (closed.length > 0) {
    const names = closed.map((id) => `«${nodeById.get(id)?.title || id}»`).join(", ");
    h.onFail(`Замкнутый цикл без входа: ${names}. Добавьте узел-исток, из которого приходит данные.`);
    return;
  }

  const roots = rootNodes(g);
  if (roots.length === 0) {
    h.onFail("Нет стартовых узлов: у каждого узла есть входящие связи.");
    return;
  }

  h.onStart(doc.nodes.length, roots);

  const latest = new Map<string, string>(); // nodeId -> последний результат
  const queue: string[] = [...roots];
  let steps = 0;

  while (queue.length > 0) {
    if (h.isAborted()) return;

    const id = queue.shift()!;
    const node = nodeById.get(id);
    if (!node) continue;

    steps += 1;
    if (steps > MAX_STEPS) {
      h.onStepLimit(steps - 1);
      return;
    }

    h.onQueue(queue);
    h.onNodeStart(id, steps);

    // в prompt идут результаты ВСЕХ входящих нод (по последнему результату)
    const srcs = [...(g.incoming.get(id) ?? [])];
    const inputs = srcs
      .filter((s) => latest.has(s))
      .map((s) => ({
        title: nodeById.get(s)?.title || s,
        result: latest.get(s)!,
      }));

    const prompt = buildPrompt(node, inputs, steps);
    h.onPrompt(id, prompt, steps);

    const t0 = performance.now();
    let answer: string;
    try {
      answer = await send(prompt);
    } catch (e) {
      if (h.isAborted()) return; // остановка пользователем — не ошибка
      const msg = e instanceof Error ? e.message : String(e);
      h.onNodeError(id, msg, steps);
      h.onFail(`Узел «${node.title}» не выполнен: ${msg}`);
      return;
    }
    if (h.isAborted()) return;

    latest.set(id, answer);
    h.onNodeDone(id, answer, steps, Math.round(performance.now() - t0));

    // разветвление: все исходящие получают результат;
    // сведение: цель войдёт в очередь, только когда готовы ВСЕ её источники
    for (const next of g.outgoing.get(id) ?? []) {
      if (!queue.includes(next) && isReady(g, next, latest)) queue.push(next);
    }
  }

  h.onDone(steps, latest);
}
