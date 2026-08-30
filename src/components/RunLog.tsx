import { useEffect, useRef, useState } from "react";
import type { LogEntry, RunSummary } from "../types";
import { IconChevron, IconTerminal, IconX } from "./icons";

interface Props {
  entries: LogEntry[];
  run: RunSummary;
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
}

const KIND_STYLE: Record<LogEntry["kind"], { label: string; cls: string }> = {
  sys: { label: "СИСТЕМА", cls: "text-mut" },
  step: { label: "ШАГ", cls: "text-cyan" },
  prompt: { label: "PROMPT", cls: "text-amber" },
  answer: { label: "ОТВЕТ", cls: "text-ok" },
  ok: { label: "ГОТОВО", cls: "text-ok" },
  warn: { label: "ВНИМАНИЕ", cls: "text-warn" },
  err: { label: "ОШИБКА", cls: "text-err" },
};

export default function RunLog({ entries, run, open, onToggle, onClear }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (follow && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [entries, follow, open]);

  const toggleExp = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const statusText =
    run.phase === "running"
      ? `ВЫПОЛНЯЕТСЯ · шаг ${run.steps + 1}`
      : run.phase === "done"
        ? `ЗАВЕРШЕНО · шагов: ${run.steps}`
        : run.phase === "error"
          ? "ОШИБКА ВЫПОЛНЕНИЯ"
          : run.phase === "stopped"
            ? `ОСТАНОВЛЕНО · шаг ${run.steps}`
            : entries.length
              ? `ПАУЗА · шагов: ${run.steps}`
              : "ОЖИДАНИЕ ЗАПУСКА";

  const statusCls =
    run.phase === "running"
      ? "text-amber"
      : run.phase === "done"
        ? "text-ok"
        : run.phase === "error"
          ? "text-err"
          : "text-mut";

  return (
    <section
      className={`flex shrink-0 flex-col border-t border-line bg-deep transition-[height] duration-300 ${
        open ? "h-[248px]" : "h-[38px]"
      }`}
    >
      {/* заголовок */}
      <div
        className="flex h-[38px] shrink-0 cursor-pointer items-center gap-3 px-4"
        onClick={onToggle}
        title={open ? "Свернуть журнал" : "Развернуть журнал"}
      >
        <IconTerminal size={15} className="text-cyan" />
        <span className="font-display text-[11px] tracking-[0.22em] text-ink uppercase">Журнал исполнения</span>
        <span className={`font-mono text-[10.5px] ${statusCls} ${run.phase === "running" ? "caret" : ""}`}>{statusText}</span>
        <span className="ml-auto flex items-center gap-2">
          {entries.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              className="flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[10px] text-dim transition-colors hover:border-err/50 hover:text-err"
            >
              <IconX size={10} /> очистить
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setFollow((f) => !f);
            }}
            className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
              follow ? "border-cyan/50 text-cyan" : "border-line text-dim hover:text-mut"
            }`}
            title="Автопрокрутка к новым событиям"
          >
            авто↓
          </button>
          <IconChevron size={14} className={`text-dim transition-transform duration-300 ${open ? "rotate-90" : "-rotate-90"}`} />
        </span>
      </div>

      {/* тело */}
      {open && (
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 font-mono text-[11px] leading-relaxed">
          {entries.length === 0 && (
            <div className="py-6 text-center text-dim">
              Журнал пуст. Нарисуйте схему и нажмите <span className="text-amber">ИСПОЛНИТЬ</span> — здесь появится пошаговый
              диалог с Qwen через CDP-транспорт.
            </div>
          )}
          {entries.map((e) => {
            const st = KIND_STYLE[e.kind];
            const long = e.kind === "prompt" || e.kind === "answer";
            const isOpen = expanded.has(e.id);
            return (
              <div key={e.id} className="anim-log group border-b border-line/40 py-1.5 last:border-0">
                <div className="flex items-baseline gap-2">
                  <span className="w-[52px] shrink-0 text-dim/70">
                    {new Date(e.t).toLocaleTimeString("ru-RU", { hour12: false })}
                  </span>
                  <span className={`w-[76px] shrink-0 font-semibold ${st.cls}`}>{st.label}</span>
                  {e.nodeTitle && <span className="shrink-0 rounded bg-raise px-1.5 text-[10px] text-ink/80">{e.nodeTitle}</span>}
                  {e.step !== undefined && <span className="shrink-0 text-[10px] text-dim">#{e.step}</span>}
                  {long ? (
                    <button
                      onClick={() => toggleExp(e.id)}
                      className="min-w-0 flex-1 truncate text-left text-mut transition-colors hover:text-ink"
                      title="Показать полностью"
                    >
                      {isOpen ? "свернуть ▴" : e.text.replace(/\s+/g, " ").slice(0, 140) + "…"}
                    </button>
                  ) : (
                    <span className={`min-w-0 flex-1 whitespace-pre-wrap ${st.cls === "text-err" ? "text-err/90" : "text-ink/80"}`}>
                      {e.text}
                    </span>
                  )}
                </div>
                {long && isOpen && (
                  <pre className="anim-rise mt-1.5 max-h-56 overflow-y-auto rounded-md border border-line bg-panel px-3 py-2 whitespace-pre-wrap text-[10.5px] leading-relaxed text-ink/85">
                    {e.text}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
