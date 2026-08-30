import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Canvas from "./components/Canvas";
import Inspector from "./components/Inspector";
import RunLog from "./components/RunLog";
import Toolbar from "./components/Toolbar";
import { runGraph } from "./lib/executor";
import { indexGraph } from "./lib/graph";
import { loadDoc, sampleCycle, sampleDiamond, sampleLinear, saveDoc } from "./lib/persist";
import { fetchHealth, sendToQwen, testQwen } from "./lib/transport";
import {
  MAX_STEPS,
  uid,
  type BPNode,
  type HealthInfo,
  type LogEntry,
  type LogKind,
  type NodeRunInfo,
  type RunSummary,
  type WorkspaceDoc,
} from "./types";

interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
}

const EMPTY: WorkspaceDoc = {
  name: "Новый процесс",
  updatedAt: Date.now(),
  nodes: [],
  edges: [],
};

export default function App() {
  const [doc, setDoc] = useState<WorkspaceDoc>(EMPTY);
  const [selection, setSelection] = useState<{ kind: "node" | "edge"; id: string } | null>(null);
  const [runInfo, setRunInfo] = useState<Map<string, NodeRunInfo>>(new Map());
  const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [run, setRun] = useState<RunSummary>({ phase: "idle", steps: 0 });
  const [health, setHealth] = useState<HealthInfo>({ ok: false, bridge: "none", providerFound: false, transport: "CDP-transport" });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveMode, setSaveMode] = useState<"server" | "local">("local");
  const [testing, setTesting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ready, setReady] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const stopFlag = useRef(false);
  const logId = useRef(1);
  const toastId = useRef(1);
  const saveTimer = useRef<number | undefined>(undefined);
  const docRef = useRef(doc);
  docRef.current = doc;

  /* ---------- загрузка ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ doc: d, mode }, h] = await Promise.all([loadDoc(), fetchHealth()]);
      if (!alive) return;
      setDoc(d ?? EMPTY);
      setSaveMode(mode);
      setHealth(h);
      setSaveState(d ? "saved" : "idle");
      setReady(true);
    })();
    const t = window.setInterval(async () => setHealth(await fetchHealth()), 12000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  /* ---------- тосты ---------- */
  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = toastId.current++;
    setToasts((ts) => [...ts.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4200);
  }, []);

  /* ---------- журнал ---------- */
  const pushLog = useCallback((kind: LogKind, text: string, nodeId?: string, step?: number) => {
    const title = nodeId ? docRef.current.nodes.find((n) => n.id === nodeId)?.title : undefined;
    setLog((l) => {
      const base = l.length > 800 ? l.slice(-600) : l;
      return [...base, { id: logId.current++, t: Date.now(), kind, text, nodeId, nodeTitle: title, step }];
    });
  }, []);

  /* ---------- автосохранение ---------- */
  useEffect(() => {
    if (!ready) return;
    setSaveState("saving");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const stamped = { ...docRef.current, updatedAt: Date.now() };
      const r = await saveDoc(stamped);
      setSaveMode(r.mode);
      setSaveState("saved");
    }, 650);
    return () => window.clearTimeout(saveTimer.current);
  }, [doc, ready]);

  /* ---------- правка графа ---------- */
  const patchDoc = useCallback((fn: (d: WorkspaceDoc) => WorkspaceDoc) => setDoc((d) => fn(d)), []);

  const addNode = useCallback(
    (x: number, y: number) => {
      const n = {
        id: uid(),
        title: `Узел ${docRef.current.nodes.length + 1}`,
        x: Math.round(x),
        y: Math.round(y),
        content: "",
      };
      patchDoc((d) => ({ ...d, nodes: [...d.nodes, n] }));
      setSelection({ kind: "node", id: n.id });
      toast("info", `Узел «${n.title}» создан — опишите задание справа`);
    },
    [patchDoc, toast],
  );

  const addEdge = useCallback(
    (from: string, to: string) => {
      const d = docRef.current;
      if (d.edges.some((e) => e.from === from && e.to === to)) {
        toast("err", "Такая связь уже есть");
        return;
      }
      const e = { id: uid(), from, to };
      patchDoc((dd) => ({ ...dd, edges: [...dd.edges, e] }));
      const a = d.nodes.find((n) => n.id === from)?.title;
      const b = d.nodes.find((n) => n.id === to)?.title;
      toast("ok", `Связь ${a} → ${b}`);
    },
    [patchDoc, toast],
  );

  const deleteNode = useCallback(
    (id: string) => {
      patchDoc((d) => ({
        ...d,
        nodes: d.nodes.filter((n) => n.id !== id),
        edges: d.edges.filter((e) => e.from !== id && e.to !== id),
      }));
      setSelection(null);
    },
    [patchDoc],
  );

  const deleteEdge = useCallback(
    (id: string) => {
      patchDoc((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== id) }));
      setSelection(null);
    },
    [patchDoc],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<Pick<BPNode, "title" | "content" | "x" | "y">>) =>
      patchDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })),
    [patchDoc],
  );

  const loadSample = useCallback(
    (kind: "linear" | "diamond" | "cycle") => {
      const s = kind === "linear" ? sampleLinear() : kind === "diamond" ? sampleDiamond() : sampleCycle();
      setDoc(s);
      setRunInfo(new Map());
      setRun({ phase: "idle", steps: 0 });
      setSelection(null);
      toast("info", `Загружена схема: ${s.name}`);
    },
    [toast],
  );

  /* ---------- ИСПОЛНЕНИЕ ---------- */
  const running = run.phase === "running";

  const startRun = useCallback(async () => {
    const d = docRef.current;
    if (running) return;
    if (d.nodes.length === 0) {
      toast("err", "Граф пуст — нечего исполнять");
      return;
    }
    const h = await fetchHealth();
    setHealth(h);
    if (!h.ok) {
      pushLog("err", "Мост СБОРКИ не отвечает. Запустите start.bat из корня репозитория.");
      toast("err", "Мост не запущен — выполните start.bat");
      return;
    }
    if (!h.providerFound) {
      pushLog("err", "Provider_Qwen.ps1 не найден рядом с мостом. Проверьте папку CDP-transport.");
      toast("err", "Провайдер Qwen не найден");
      return;
    }

    stopFlag.current = false;
    abortRef.current = new AbortController();
    setRunInfo(new Map());
    setActiveEdges(new Set());
    setRun({ phase: "running", steps: 0, startedAt: Date.now() });
    setLogOpen(true);
    pushLog("sys", `Старт прогона: ${d.nodes.length} узл., ${d.edges.length} свз. Транспорт: ${h.bridge === "ps" ? "serve.ps1" : "server.mjs"} → Provider_Qwen.ps1 → Qwen.`);

    const g = indexGraph(d.nodes, d.edges);

    await runGraph(
      d,
      async (prompt) => {
        const reply = await sendToQwen(prompt, abortRef.current?.signal);
        if (!reply.ok || !reply.answer) throw new Error(reply.error || "Qwen не вернул ответ (пусто)");
        return reply.answer;
      },
      {
        isAborted: () => stopFlag.current,
        onStart: (_total, roots) => {
          const names = roots.map((id) => d.nodes.find((n) => n.id === id)?.title || id).join(", ");
          pushLog("sys", `Стартовые узлы: ${names}. Сведение ждёт все входы, циклы ограничены ${MAX_STEPS} шагами.`);
        },
        onQueue: () => {},
        onNodeStart: (id, step) => {
          setRun((r) => ({ ...r, steps: step - 1 }));
          setRunInfo((m) => {
            const n = new Map(m);
            const prev = n.get(id);
            n.set(id, { status: "running", step, startedAt: Date.now(), execCount: (prev?.execCount ?? 0) + 1 });
            return n;
          });
          // подсвечиваем входящие рёбра — по ним только что пришли результаты
          // (узел стартует лишь когда все его источники готовы)
          const inc = new Set<string>();
          g.edges.forEach((e) => {
            if (e.to === id) inc.add(e.id);
          });
          setActiveEdges(inc);
          const title = d.nodes.find((n) => n.id === id)?.title || id;
          pushLog("step", `Узел «${title}» исполняется (шаг ${step})…`, id, step);
        },
        onPrompt: (id, prompt, step) => pushLog("prompt", prompt, id, step),
        onNodeDone: (id, answer, step, ms) => {
          setRunInfo((m) => {
            const n = new Map(m);
            const prev = n.get(id);
            n.set(id, { status: "done", step, result: answer, startedAt: prev?.startedAt, finishedAt: Date.now(), execCount: prev?.execCount ?? 1 });
            return n;
          });
          // исходящие рёбра «текут» — результат разошёлся по ветвям
          const out = new Set<string>();
          g.edges.forEach((e) => {
            if (e.from === id) out.add(e.id);
          });
          setActiveEdges(out);
          window.setTimeout(() => setActiveEdges(new Set()), 1500);
          const title = d.nodes.find((n) => n.id === id)?.title || id;
          pushLog("answer", answer, id, step);
          pushLog("ok", `«${title}» готов за ${(ms / 1000).toFixed(1)} с — результат передан по ${out.size} свз.`, id, step);
        },
        onNodeError: (id, error, step) => {
          setRunInfo((m) => {
            const n = new Map(m);
            const prev = n.get(id);
            n.set(id, { status: "error", step, error, finishedAt: Date.now(), execCount: prev?.execCount ?? 1 });
            return n;
          });
          setActiveEdges(new Set());
          pushLog("err", error, id, step);
        },
        onStepLimit: (step) => {
          pushLog("err", `Аварийный предел: превышен MAX_STEPS = ${MAX_STEPS}. Исполнение остановлено.`);
          setRun({ phase: "error", steps: step, finishedAt: Date.now(), message: `Превышен аварийный предел MAX_STEPS = ${MAX_STEPS}` });
        },
        onDone: (steps) => {
          setActiveEdges(new Set());
          setRun({ phase: "done", steps, finishedAt: Date.now() });
          pushLog("ok", `Прогон завершён: ${steps} шаг(ов). Все результаты — в узлах (правая панель).`);
          toast("ok", `Готово: ${steps} шаг(ов)`);
        },
        onFail: (message) => {
          setActiveEdges(new Set());
          setRun((r) => ({ phase: "error", steps: r.steps, finishedAt: Date.now(), message }));
          pushLog("err", message);
          toast("err", "Прогон не завершён — детали в журнале");
        },
      },
    );

    if (stopFlag.current) {
      setRun((r) => ({ phase: "stopped", steps: r.steps, finishedAt: Date.now() }));
      pushLog("warn", "Остановлено пользователем. Текущий запрос к Qwen мог дописаться в чат.");
      toast("info", "Прогон остановлен");
    }
  }, [running, pushLog, toast]);

  const stopRun = useCallback(() => {
    stopFlag.current = true;
    abortRef.current?.abort();
  }, []);

  /* ---------- тест транспорта ---------- */
  const doTest = useCallback(async () => {
    setTesting(true);
    pushLog("sys", "Тест транспорта: провайдер отправит «Напиши одно слово: ТЕСТ.» и сохранит qwen_test_result.txt в data/.");
    try {
      const r = await testQwen();
      if (r.ok && r.answer) {
        pushLog("answer", r.answer);
        pushLog("ok", "Транспорт работает: Qwen ответил через CDP.");
        toast("ok", "Qwen ответил — транспорт в порядке");
      } else {
        pushLog("err", r.error || "Тест не вернул ответ.");
        toast("err", r.error || "Тест не прошёл");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog("err", `Тест транспорта: ${msg}`);
      toast("err", msg);
    } finally {
      setTesting(false);
    }
  }, [pushLog, toast]);

  /* ---------- горячие клавиши ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA";
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void startRun();
        return;
      }
      if (e.key === "Escape") setSelection(null);
      if (e.key === "Delete" && !inField && selection && !running) {
        if (selection.kind === "node") deleteNode(selection.id);
        else deleteEdge(selection.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, running, startRun, deleteNode, deleteEdge]);

  const stats = useMemo(() => indexGraph(doc.nodes, doc.edges), [doc]);
  void stats;

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <div className="anim-rise flex flex-col items-center gap-3">
          <div className="spin h-8 w-8 rounded-full border-2 border-line2 border-t-amber" />
          <div className="font-display text-[12px] tracking-[0.25em] text-mut uppercase">Читаю процесс…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-bg text-ink">
      {/* амбиентный фон */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-32 -left-32 h-[420px] w-[420px] rounded-full bg-amber/[0.05] blur-[110px]" />
        <div className="absolute -right-40 -bottom-40 h-[480px] w-[480px] rounded-full bg-cyan/[0.05] blur-[120px]" />
        <div className="scan-overlay absolute inset-0" />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <Toolbar
          projectName={doc.name}
          onRename={(name) => patchDoc((d) => ({ ...d, name }))}
          saveState={saveState}
          saveMode={saveMode}
          health={health}
          phase={run.phase}
          onRun={() => void startRun()}
          onStop={stopRun}
        />

        <div className="flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1 bg-deep/40">
            <Canvas
              nodes={doc.nodes}
              edges={doc.edges}
              selection={selection}
              runInfo={runInfo}
              activeEdges={activeEdges}
              locked={running}
              onSelect={setSelection}
              onMoveNode={(id, x, y) => updateNode(id, { x, y })}
              onAddNode={addNode}
              onAddEdge={addEdge}
              onDeleteEdge={deleteEdge}
              onLoadSample={() => loadSample("linear")}
            />
          </main>
          <Inspector
            doc={doc}
            selection={selection}
            runInfo={runInfo}
            run={run}
            health={health}
            bridgeMode={saveMode}
            testing={testing}
            onUpdateNode={updateNode}
            onDeleteNode={deleteNode}
            onDeleteEdge={deleteEdge}
            onClearRun={() => {
              setRunInfo(new Map());
              setRun({ phase: "idle", steps: 0 });
              setActiveEdges(new Set());
            }}
            onLoadSample={loadSample}
            onTest={() => void doTest()}
          />
        </div>

        <RunLog entries={log} run={run} open={logOpen} onToggle={() => setLogOpen((o) => !o)} onClear={() => setLog([])} />
      </div>

      {/* тосты */}
      <div className="pointer-events-none absolute top-[68px] right-[330px] z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`anim-toast pointer-events-auto flex items-center gap-2.5 rounded-md border px-3.5 py-2.5 font-mono text-[11.5px] shadow-[0_10px_30px_rgba(0,0,0,.5)] backdrop-blur ${
              t.kind === "ok"
                ? "border-ok/40 bg-ok/12 text-ok"
                : t.kind === "err"
                  ? "border-err/40 bg-err/12 text-err"
                  : "border-cyan/40 bg-cyan/10 text-cyan2"
            }`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.kind === "ok" ? "bg-ok" : t.kind === "err" ? "bg-err" : "bg-cyan"}`} />
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
