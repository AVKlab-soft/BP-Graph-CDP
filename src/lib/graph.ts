import type { BPEdge, BPNode } from "../types";

/* ============================================================
   Обход существующего графа nodes + edges:
   разветвление (один результат уходит всем исходящим),
   сведение (нода ждёт результаты ВСЕХ входящих),
   циклы (повторный вход разрешён, счётчик шагов глобальный).
   ============================================================ */

export interface GraphIndex {
  /** nodeId -> уникальные id входящих нод */
  incoming: Map<string, Set<string>>;
  /** nodeId -> id исходящих нод (в порядке рёбер) */
  outgoing: Map<string, string[]>;
  /** нормализованные рёбра (без дубликатов и ссылок на несуществующие ноды) */
  edges: BPEdge[];
}

export function indexGraph(nodes: BPNode[], edges: BPEdge[]): GraphIndex {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, string[]>();
  nodes.forEach((n) => {
    incoming.set(n.id, new Set());
    outgoing.set(n.id, []);
  });

  const seen = new Set<string>();
  const clean: BPEdge[] = [];
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const key = `${e.from}→${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(e);
    incoming.get(e.to)!.add(e.from);
    outgoing.get(e.from)!.push(e.to);
  }
  return { incoming, outgoing, edges: clean };
}

/** Стартовые ноды — без входящих рёбер. */
export function rootNodes(g: GraphIndex): string[] {
  const roots: string[] = [];
  g.incoming.forEach((srcs, id) => {
    if (srcs.size === 0) roots.push(id);
  });
  return roots;
}

/** Нода готова, если все её источники уже дали результат. */
export function isReady(g: GraphIndex, id: string, latest: Map<string, string>): boolean {
  const srcs = g.incoming.get(id);
  if (!srcs || srcs.size === 0) return true;
  for (const s of srcs) if (!latest.has(s)) return false;
  return true;
}

/** Честная диагностика: есть ли в графе чистые циклы без входа. */
export function findClosedCycles(g: GraphIndex): string[] {
  // ноды, недостижимые от стартовых — замкнутые циклы
  const roots = new Set(rootNodes(g));
  const reached = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of g.outgoing.get(id) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  const closed: string[] = [];
  g.incoming.forEach((_v, id) => {
    if (!reached.has(id)) closed.push(id);
  });
  return closed;
}

/** Присутствуют ли циклы вообще (для подсказки в UI). */
export function hasCycles(g: GraphIndex): boolean {
  const color = new Map<string, number>(); // 0 white 1 gray 2 black
  const dfs = (id: string): boolean => {
    color.set(id, 1);
    for (const next of g.outgoing.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) return true;
      if (c === 0 && dfs(next)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const id of g.incoming.keys()) {
    if ((color.get(id) ?? 0) === 0 && dfs(id)) return true;
  }
  return false;
}
