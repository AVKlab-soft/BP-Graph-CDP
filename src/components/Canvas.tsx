import { useCallback, useMemo, useRef, useState } from "react";
import { NODE_H, NODE_W, type BPEdge, type BPNode, type NodeRunInfo } from "../types";
import { IconFit, IconGraph, IconZoomIn, IconZoomOut } from "./icons";

interface View {
  x: number;
  y: number;
  k: number;
}

interface Props {
  nodes: BPNode[];
  edges: BPEdge[];
  selection: { kind: "node" | "edge"; id: string } | null;
  runInfo: Map<string, NodeRunInfo>;
  activeEdges: Set<string>;
  locked: boolean;
  onSelect: (sel: { kind: "node" | "edge"; id: string } | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onAddNode: (x: number, y: number) => void;
  onAddEdge: (from: string, to: string) => void;
  onDeleteEdge: (id: string) => void;
  onLoadSample: () => void;
}

const clampK = (k: number) => Math.min(2.2, Math.max(0.35, k));

function edgePath(a: BPNode, b: BPNode) {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.min(130, Math.max(46, Math.abs(x2 - x1) * 0.5));
  return {
    d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
    mid: {
      x: (x1 + 3 * (x1 + dx) + 3 * (x2 - dx) + x2) / 8,
      y: (y1 + 3 * y1 + 3 * y2 + y2) / 8,
    },
  };
}

export default function Canvas({
  nodes,
  edges,
  selection,
  runInfo,
  activeEdges,
  locked,
  onSelect,
  onMoveNode,
  onAddNode,
  onAddEdge,
  onDeleteEdge,
  onLoadSample,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 60, y: 20, k: 1 });
  const [panning, setPanning] = useState(false);
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const linkRef = useRef(link);
  linkRef.current = link;

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const toWorld = useCallback(
    (cx: number, cy: number) => {
      const r = wrapRef.current!.getBoundingClientRect();
      return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
    },
    [view],
  );

  /* ---------- зум колесом ---------- */
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const r = wrapRef.current!.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const k = clampK(v.k * (1 - e.deltaY * 0.0012));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    },
    [],
  );

  const zoomBy = (f: number) => {
    const r = wrapRef.current?.getBoundingClientRect();
    const mx = r ? r.width / 2 : 400;
    const my = r ? r.height / 2 : 300;
    setView((v) => {
      const k = clampK(v.k * f);
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  };

  const fitView = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || nodes.length === 0) {
      setView({ x: 60, y: 20, k: 1 });
      return;
    }
    const minX = Math.min(...nodes.map((n) => n.x)) - 60;
    const minY = Math.min(...nodes.map((n) => n.y)) - 60;
    const maxX = Math.max(...nodes.map((n) => n.x + NODE_W)) + 60;
    const maxY = Math.max(...nodes.map((n) => n.y + NODE_H)) + 60;
    const k = clampK(Math.min(r.width / (maxX - minX), r.height / (maxY - minY)));
    setView({ k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k });
  }, [nodes]);

  /* ---------- фон: пан ---------- */
  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    panRef.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    setPanning(true);
    onSelect(null);
  };
  const onBgPointerMove = (e: React.PointerEvent) => {
    if (panRef.current) {
      const p = panRef.current;
      setView((v) => ({ ...v, x: p.vx + (e.clientX - p.sx), y: p.vy + (e.clientY - p.sy) }));
    }
    if (linkRef.current) {
      const w = toWorld(e.clientX, e.clientY);
      setLink((l) => (l ? { ...l, x: w.x, y: w.y } : l));
    }
  };
  const onBgPointerUp = () => {
    panRef.current = null;
    setPanning(false);
    if (linkRef.current) setLink(null);
  };

  const onDouble = (e: React.MouseEvent) => {
    if (locked) return;
    const w = toWorld(e.clientX, e.clientY);
    onAddNode(w.x - NODE_W / 2, w.y - NODE_H / 2);
  };

  /* ---------- ноды ---------- */
  const onNodePointerDown = (e: React.PointerEvent, n: BPNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect({ kind: "node", id: n.id });
    if (locked) return;
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = { id: n.id, dx: w.x - n.x, dy: w.y - n.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onNodePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const w = toWorld(e.clientX, e.clientY);
    onMoveNode(d.id, Math.round(w.x - d.dx), Math.round(w.y - d.dy));
  };
  const onNodePointerUp = (e: React.PointerEvent, n: BPNode) => {
    const l = linkRef.current;
    if (l && l.from !== n.id) {
      e.stopPropagation();
      onAddEdge(l.from, n.id);
      setLink(null);
      return;
    }
    dragRef.current = null;
  };

  const onPortDown = (e: React.PointerEvent, n: BPNode) => {
    if (locked) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setLink({ from: n.id, x: n.x + NODE_W, y: n.y + NODE_H / 2 });
    onSelect({ kind: "node", id: n.id });
  };
  const onPortMove = (e: React.PointerEvent) => {
    if (!linkRef.current) return;
    const w = toWorld(e.clientX, e.clientY);
    setLink((l) => (l ? { ...l, x: w.x, y: w.y } : l));
  };
  const onPortUp = () => {
    if (linkRef.current && hoverNode && hoverNode !== linkRef.current.from) {
      onAddEdge(linkRef.current.from, hoverNode);
    }
    setLink(null);
  };

  /* ---------- рёбра ---------- */
  const edgeEls = edges.map((e) => {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) return null;
    const { d, mid } = edgePath(a, b);
    const sel = selection?.kind === "edge" && selection.id === e.id;
    const active = activeEdges.has(e.id);
    const delivered = runInfo.get(e.from)?.status === "done";
    return (
      <g key={e.id}>
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={14}
          className="cursor-pointer"
          onPointerDown={(ev) => {
            ev.stopPropagation();
            onSelect({ kind: "edge", id: e.id });
          }}
        />
        <path
          d={d}
          fill="none"
          stroke={sel ? "#f5a524" : active ? "#7fe3ea" : delivered ? "#2e6e75" : "#33465a"}
          strokeWidth={sel ? 2.4 : active ? 2.2 : 1.6}
          className={active ? "edge-flow" : undefined}
          markerEnd={sel ? "url(#arw-amber)" : active ? "url(#arw-cyan)" : "url(#arw)"}
          style={{ transition: "stroke .25s" }}
          pointerEvents="none"
        />
        {sel && !locked && (
          <g
            className="cursor-pointer"
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={() => onDeleteEdge(e.id)}
            transform={`translate(${mid.x}, ${mid.y})`}
          >
            <circle r={10} fill="#151c25" stroke="#f85149" strokeWidth={1.4} />
            <path d="M -3.4 -3.4 L 3.4 3.4 M 3.4 -3.4 L -3.4 3.4" stroke="#f85149" strokeWidth={1.7} strokeLinecap="round" />
          </g>
        )}
      </g>
    );
  });

  const linkFromNode = link ? nodeById.get(link.from) : null;

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden select-none"
      style={{ cursor: panning ? "grabbing" : "default" }}
      onWheel={onWheel}
    >
      {/* сетка-пол, следует за панорамой */}
      <div
        className="grid-floor absolute inset-0"
        style={{
          backgroundSize: `${26 * view.k}px ${26 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={onBgPointerDown}
        onPointerMove={onBgPointerMove}
        onPointerUp={onBgPointerUp}
        onDoubleClick={onDouble}
      />

      {/* мир */}
      <div
        className="absolute top-0 left-0"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}
      >
        <svg
          className="pointer-events-none absolute overflow-visible"
          style={{ left: 0, top: 0, width: 1, height: 1 }}
        >
          <defs>
            <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#4a5f77" />
            </marker>
            <marker id="arw-cyan" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#7fe3ea" />
            </marker>
            <marker id="arw-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#f5a524" />
            </marker>
          </defs>
          <g className="pointer-events-auto">{edgeEls}</g>
          {link && linkFromNode && (
            <path
              d={`M ${linkFromNode.x + NODE_W} ${linkFromNode.y + NODE_H / 2} L ${link.x} ${link.y}`}
              stroke="#f5a524"
              strokeWidth={2}
              strokeDasharray="6 5"
              fill="none"
              className="edge-flow"
            />
          )}
        </svg>

        {/* ноды */}
        {nodes.map((n) => {
          const info = runInfo.get(n.id);
          const st = info?.status ?? "idle";
          const sel = selection?.kind === "node" && selection.id === n.id;
          const border =
            st === "running"
              ? "border-amber/70"
              : st === "done"
                ? "border-ok/60"
                : st === "error"
                  ? "border-err/70"
                  : sel
                    ? "border-cyan/70"
                    : "border-line2 hover:border-cyan/40";
          return (
            <div
              key={n.id}
              className={`group absolute rounded-lg border bg-panel/95 transition-colors duration-200 ${border} ${
                st === "running" ? "node-running" : ""
              } ${sel ? "shadow-[0_0_0_1px_rgba(63,198,208,.35),0_10px_30px_rgba(0,0,0,.5)]" : "shadow-[0_6px_18px_rgba(0,0,0,.42)]"}`}
              style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H, cursor: locked ? "default" : "grab" }}
              onPointerDown={(e) => onNodePointerDown(e, n)}
              onPointerMove={onNodePointerMove}
              onPointerUp={(e) => onNodePointerUp(e, n)}
              onPointerEnter={() => setHoverNode(n.id)}
              onPointerLeave={() => setHoverNode((h) => (h === n.id ? null : h))}
            >
              {/* входной порт */}
              <div
                className="absolute top-1/2 -left-[7px] h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-cyan/70 bg-deep transition-transform group-hover:scale-125"
                title="вход"
              />
              {/* выходной порт */}
              <div
                className={`absolute top-1/2 -right-[7px] h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 bg-deep transition-transform ${
                  locked ? "border-dim" : "cursor-crosshair border-amber/80 hover:scale-150"
                }`}
                title="потяните к другому узлу, чтобы создать связь"
                onPointerDown={(e) => onPortDown(e, n)}
                onPointerMove={onPortMove}
                onPointerUp={onPortUp}
              />
              <div className="flex h-full flex-col px-3 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      st === "running"
                        ? "led-run bg-amber"
                        : st === "done"
                          ? "led-ok bg-ok"
                          : st === "error"
                            ? "bg-err"
                            : st === "queued"
                              ? "bg-amber/50"
                              : "bg-line2"
                    }`}
                  />
                  <span className="truncate font-display text-[12.5px] tracking-wide text-ink">{n.title}</span>
                  {info && info.step !== undefined && st !== "idle" && (
                    <span
                      className={`ml-auto rounded px-1.5 font-mono text-[10px] leading-4 ${
                        st === "error" ? "bg-err/15 text-err" : "bg-raise text-mut"
                      }`}
                    >
                      #{info.step}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 line-clamp-2 flex-1 font-mono text-[10.5px] leading-[1.45] text-dim">
                  {n.content.trim() || "пустое задание — двойной клик… нет, выберите узел и опишите задание справа"}
                </div>
                <div className="flex items-center justify-between border-t border-line/70 pt-1">
                  <span className="font-mono text-[9.5px] text-dim/80">{n.id}</span>
                  {st === "done" && <span className="font-mono text-[9.5px] text-ok">ответ: {(info?.result || "").length} зн.</span>}
                  {st === "error" && <span className="font-mono text-[9.5px] text-err">сбой</span>}
                  {st === "running" && <span className="caret font-mono text-[9.5px] text-amber">qwen</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* пустое состояние */}
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="anim-rise pointer-events-auto flex flex-col items-center gap-4 rounded-xl border border-dashed border-line2 bg-panel/70 px-10 py-9 text-center backdrop-blur-sm">
            <IconGraph size={34} className="text-dim" />
            <div>
              <div className="font-display text-lg tracking-wide text-ink">Холст процесса пуст</div>
              <div className="mt-1 max-w-[340px] text-[13px] leading-relaxed text-mut">
                Двойной клик по холсту — новый узел. Тяните от янтарного порта к другому узлу — связь.{" "}
                <span className="text-cyan">ИСПОЛНИТЬ</span> прогонит граф через Qwen.
              </div>
            </div>
            <button
              onClick={onLoadSample}
              className="btn-bezel rounded-md bg-raise px-4 py-2 font-display text-[12px] tracking-widest text-amber uppercase"
            >
              Загрузить пример A → B → C
            </button>
          </div>
        </div>
      )}

      {/* управление видом */}
      <div className="absolute bottom-4 left-4 flex items-center gap-1.5">
        {[
          { icon: <IconZoomOut size={15} />, fn: () => zoomBy(1 / 1.25), t: "Отдалить" },
          { icon: <IconZoomIn size={15} />, fn: () => zoomBy(1.25), t: "Приблизить" },
          { icon: <IconFit size={15} />, fn: fitView, t: "Показать всё" },
        ].map((b, i) => (
          <button
            key={i}
            title={b.t}
            onClick={b.fn}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line bg-panel/90 text-mut transition-colors hover:border-cyan/50 hover:text-cyan"
          >
            {b.icon}
          </button>
        ))}
        <span className="ml-1 rounded border border-line bg-panel/90 px-2 py-1 font-mono text-[10.5px] text-dim">
          {Math.round(view.k * 100)}%
        </span>
      </div>

      {locked && (
        <div className="stripe-live absolute top-3 left-1/2 -translate-x-1/2 rounded-md border border-amber/40 px-4 py-1.5 font-display text-[11px] tracking-[0.2em] text-amber uppercase">
          Идёт исполнение — холст зафиксирован
        </div>
      )}
    </div>
  );
}
