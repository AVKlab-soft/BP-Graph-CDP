import type { HealthInfo, NodeRunInfo, RunSummary, WorkspaceDoc } from "../types";
import { hasCycles, indexGraph, rootNodes } from "../lib/graph";
import { IconBroom, IconChip, IconCopy, IconFlask, IconTarget, IconTrash } from "./icons";

interface Props {
  doc: WorkspaceDoc;
  selection: { kind: "node" | "edge"; id: string } | null;
  runInfo: Map<string, NodeRunInfo>;
  run: RunSummary;
  health: HealthInfo;
  bridgeMode: "server" | "local";
  testing: boolean;
  onUpdateNode: (id: string, patch: Partial<{ title: string; content: string }>) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
  onClearRun: () => void;
  onLoadSample: (kind: "linear" | "diamond" | "cycle") => void;
  onTest: () => void;
}

const fmtDur = (ms?: number) => {
  if (!ms) return "—";
  if (ms < 1000) return `${ms} мс`;
  return `${(ms / 1000).toFixed(1)} с`;
};

export default function Inspector(p: Props) {
  const { doc, selection, runInfo, run, health } = p;
  const g = indexGraph(doc.nodes, doc.edges);

  const node =
    selection?.kind === "node" ? doc.nodes.find((n) => n.id === selection.id) : undefined;
  const edge =
    selection?.kind === "edge" ? doc.edges.find((e) => e.id === selection.id) : undefined;

  return (
    <aside className="flex h-full w-[318px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="font-display text-[11px] tracking-[0.22em] text-mut uppercase">
          {node ? "Узел" : edge ? "Связь" : "Процесс"}
        </span>
        <span className="font-mono text-[10px] text-dim">
          {node ? node.id : edge ? edge.id : `${doc.nodes.length} узл · ${doc.edges.length} свз`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ---------- УЗЕЛ ---------- */}
        {node && (
          <div className="anim-rise flex flex-col gap-3 p-4">
            <label className="block">
              <span className="mb-1 block text-[10.5px] font-semibold tracking-wider text-dim uppercase">
                Название
              </span>
              <input
                value={node.title}
                onChange={(e) => p.onUpdateNode(node.id, { title: e.target.value })}
                className="w-full rounded-md border border-line bg-deep px-2.5 py-1.5 font-display text-[13px] text-ink outline-none focus:border-cyan/60"
              />
            </label>

            <label className="block">
              <span className="mb-1 flex items-center justify-between text-[10.5px] font-semibold tracking-wider text-dim uppercase">
                Задание узла (уходит в Qwen)
                <span className="font-mono text-[9.5px] normal-case">{node.id}.md</span>
              </span>
              <textarea
                value={node.content}
                onChange={(e) => p.onUpdateNode(node.id, { content: e.target.value })}
                placeholder="Что должен сделать Qwen на этом шаге…"
                className="h-36 w-full resize-none rounded-md border border-line bg-deep px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-ink outline-none placeholder:text-dim/70 focus:border-cyan/60"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-line bg-raise/60 px-2.5 py-2">
                <div className="font-mono text-[9.5px] text-dim uppercase">входящие</div>
                <div className="font-display text-[15px] text-cyan">{g.incoming.get(node.id)?.size ?? 0}</div>
              </div>
              <div className="rounded-md border border-line bg-raise/60 px-2.5 py-2">
                <div className="font-mono text-[9.5px] text-dim uppercase">исходящие</div>
                <div className="font-display text-[15px] text-amber">{g.outgoing.get(node.id)?.length ?? 0}</div>
              </div>
            </div>

            {/* результат прогона */}
            {(() => {
              const info = runInfo.get(node.id);
              if (!info || info.status === "idle") return null;
              return (
                <div className="anim-rise rounded-md border border-line bg-deep">
                  <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
                    <span
                      className={`font-display text-[10px] tracking-[0.18em] uppercase ${
                        info.status === "error"
                          ? "text-err"
                          : info.status === "running"
                            ? "text-amber"
                            : "text-ok"
                      }`}
                    >
                      {info.status === "error"
                        ? "Ошибка"
                        : info.status === "running"
                          ? `Шаг ${info.step} · ждём Qwen`
                          : `Результат · шаг ${info.step}`}
                    </span>
                    {info.finishedAt && info.startedAt && (
                      <span className="font-mono text-[9.5px] text-dim">{fmtDur(info.finishedAt - info.startedAt)}</span>
                    )}
                  </div>
                  <div className="max-h-44 overflow-y-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink/90">
                    {info.status === "error" ? info.error : info.result || (info.status === "running" ? "…" : "")}
                  </div>
                  {info.result && (
                    <button
                      onClick={() => navigator.clipboard?.writeText(info.result!)}
                      className="flex w-full items-center justify-center gap-1.5 border-t border-line py-1.5 text-[10.5px] text-mut transition-colors hover:bg-raise hover:text-cyan"
                    >
                      <IconCopy size={12} /> скопировать ответ
                    </button>
                  )}
                </div>
              );
            })()}

            <button
              onClick={() => p.onDeleteNode(node.id)}
              className="mt-1 flex items-center justify-center gap-2 rounded-md border border-err/30 py-2 text-[12px] font-semibold text-err/90 transition-colors hover:border-err/70 hover:bg-err/10"
            >
              <IconTrash size={14} /> Удалить узел
            </button>
          </div>
        )}

        {/* ---------- СВЯЗЬ ---------- */}
        {edge && (
          <div className="anim-rise flex flex-col gap-3 p-4">
            <div className="rounded-md border border-line bg-deep px-3 py-3 font-mono text-[12px]">
              <div className="text-dim">передача результата:</div>
              <div className="mt-1.5 flex items-center gap-2 text-ink">
                <span className="rounded bg-cyan/10 px-2 py-0.5 text-cyan">
                  {doc.nodes.find((n) => n.id === edge.from)?.title || edge.from}
                </span>
                <span className="text-dim">→</span>
                <span className="rounded bg-amber/10 px-2 py-0.5 text-amber">
                  {doc.nodes.find((n) => n.id === edge.to)?.title || edge.to}
                </span>
              </div>
            </div>
            <p className="text-[11.5px] leading-relaxed text-mut">
              Результат исходного узла попадёт в prompt целевого узла в блоке «ВХОДНЫЕ РЕЗУЛЬТАТЫ».
            </p>
            <button
              onClick={() => p.onDeleteEdge(edge.id)}
              className="flex items-center justify-center gap-2 rounded-md border border-err/30 py-2 text-[12px] font-semibold text-err/90 transition-colors hover:border-err/70 hover:bg-err/10"
            >
              <IconTrash size={14} /> Удалить связь
            </button>
          </div>
        )}

        {/* ---------- ПРОЦЕСС ---------- */}
        {!node && !edge && (
          <div className="anim-rise flex flex-col gap-4 p-4">
            {/* транспорт */}
            <section className="rounded-lg border border-line bg-raise/50 p-3">
              <div className="flex items-center gap-2">
                <IconChip size={15} className={health.ok ? "text-ok" : "text-dim"} />
                <span className="font-display text-[10.5px] tracking-[0.2em] text-mut uppercase">Транспорт</span>
                <span
                  className={`ml-auto h-2 w-2 rounded-full ${
                    health.ok ? (health.providerFound ? "bg-ok" : "bg-warn") : "bg-err"
                  }`}
                />
              </div>
              <div className="mt-2 space-y-1 font-mono text-[10.5px] leading-relaxed">
                <Row k="канал" v={health.ok ? "узел СБОРКИ (on-line)" : "нет связи"} tone={health.ok ? "ok" : "err"} />
                <Row k="транспорт Qwen" v={health.pipeName} tone={health.ok ? "ok" : "mut"} />
                <Row k="Provider_Qwen.ps1" v={health.providerFound ? "найден" : "нет"} tone={health.providerFound ? "ok" : "warn"} />
                <Row k="Chrome CDP" v="127.0.0.1:9222" tone="mut" />
              </div>
              {!health.ok && (
                <p className="mt-2 rounded border border-err/25 bg-err/8 px-2.5 py-2 text-[11px] leading-relaxed text-err/90">
                  Локальный узел не отвечает. Запустите <b className="font-mono">start.bat</b> из корня репозитория — он поднимет узел,
                  Named Pipe <b className="font-mono">{health.pipeName}</b> и найдёт провайдер автоматически. Промпт и ответ пойдут через
                  оперативную память, минуя диск и HTTP.
                </p>
              )}
              {health.ok && (
                <button
                  onClick={p.onTest}
                  disabled={p.testing}
                  className="btn-bezel mt-2.5 flex w-full items-center justify-center gap-2 rounded-md bg-raise py-2 font-display text-[10.5px] tracking-[0.16em] text-cyan uppercase disabled:opacity-50"
                >
                  <IconFlask size={13} /> {p.testing ? "Тест идёт…" : "Тест транспорта"}
                </button>
              )}
            </section>

            {/* структура */}
            <section>
              <div className="mb-1.5 flex items-center gap-2">
                <IconTarget size={14} className="text-dim" />
                <span className="font-display text-[10.5px] tracking-[0.2em] text-mut uppercase">Структура графа</span>
              </div>
              <div className="rounded-md border border-line bg-deep px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-mut">
                <div>
                  старт:{" "}
                  {rootNodes(g).length === 0 ? (
                    <span className="text-err">нет</span>
                  ) : (
                    <span className="text-ink">
                      {rootNodes(g)
                        .map((id) => doc.nodes.find((n) => n.id === id)?.title || id)
                        .join(", ")}
                    </span>
                  )}
                </div>
                <div>
                  циклы:{" "}
                  {hasCycles(g) ? (
                    <span className="text-warn">есть (лимит {1000} шагов)</span>
                  ) : (
                    <span className="text-ink">нет</span>
                  )}
                </div>
                <div>
                  исполнение: <span className="text-ink">последовательное, 1 чат Qwen</span>
                </div>
              </div>
            </section>

            {/* итоги прогона */}
            {run.phase !== "idle" && (
              <section className="anim-rise">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-display text-[10.5px] tracking-[0.2em] text-mut uppercase">Прогон</span>
                  <button
                    onClick={p.onClearRun}
                    className="flex items-center gap-1 text-[10px] text-dim transition-colors hover:text-err"
                  >
                    <IconBroom size={11} /> сбросить
                  </button>
                </div>
                <div
                  className={`rounded-md border px-3 py-2.5 font-mono text-[11px] leading-relaxed ${
                    run.phase === "done"
                      ? "border-ok/30 bg-ok/8 text-ok"
                      : run.phase === "error"
                        ? "border-err/30 bg-err/8 text-err"
                        : run.phase === "running"
                          ? "border-amber/30 bg-amber/8 text-amber"
                          : "border-line bg-deep text-mut"
                  }`}
                >
                  {run.phase === "done" && `Готово: ${run.steps} шаг(ов) за ${fmtDur((run.finishedAt || 0) - (run.startedAt || 0))}`}
                  {run.phase === "error" && run.message}
                  {run.phase === "stopped" && `Остановлено пользователем на шаге ${run.steps}`}
                  {run.phase === "running" && `Выполняется шаг ${run.steps + 1}…`}
                </div>
              </section>
            )}

            {/* примеры */}
            <section>
              <div className="mb-1.5 font-display text-[10.5px] tracking-[0.2em] text-mut uppercase">
                Схемы для проверки
              </div>
              <div className="flex flex-col gap-1.5">
                {(
                  [
                    ["linear", "A → B → C", "цепочка"],
                    ["diamond", "A → B, A → C → D", "ветвление + сведение"],
                    ["cycle", "A → B → C → B", "цикл"],
                  ] as const
                ).map(([kind, label, note]) => (
                  <button
                    key={kind}
                    onClick={() => p.onLoadSample(kind)}
                    className="group flex items-center justify-between rounded-md border border-line bg-deep px-3 py-2 text-left transition-colors hover:border-cyan/50 hover:bg-raise"
                  >
                    <span className="font-mono text-[11.5px] text-ink group-hover:text-cyan">{label}</span>
                    <span className="text-[10px] text-dim">{note}</span>
                  </button>
                ))}
              </div>
            </section>

            <p className="mt-auto border-t border-line pt-3 text-[10.5px] leading-relaxed text-dim">
              Граф хранится в localStorage браузера. Промпты и ответы Qwen не сохраняются — они проходят через Named Pipe в оперативной памяти.
              Двойной клик по холсту — новый узел. Del — удалить выбранное.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone: "ok" | "err" | "warn" | "mut" }) {
  const c = tone === "ok" ? "text-ok" : tone === "err" ? "text-err" : tone === "warn" ? "text-warn" : "text-mut";
  return (
    <div className="flex justify-between gap-2">
      <span className="text-dim">{k}</span>
      <span className={`truncate text-right ${c}`}>{v}</span>
    </div>
  );
}
