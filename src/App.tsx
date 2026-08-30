import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Canvas from "./components/Canvas";
import Inspector from "./components/Inspector";
import RunLog from "./components/RunLog";
import Toolbar from "./components/Toolbar";
import { indexGraph } from "./lib/graph";
import { loadDoc, sampleCycle, sampleDiamond, sampleLinear, saveDoc, type SaveMode } from "./lib/persist";
import { hostLink, PIPE_NAME, type HostEvent } from "./lib/transport";
import {
  MAX_STEPS,
  uid,
  type BPNode,
  type HealthInfo,
  type LinkStatus,
  type LogEntry,
  type LogKind,
  type NodeRunInfo,
  type RunSummary,
  type WorkspaceDoc,
} from "./types";

const OFF_HEALTH: HealthInfo = {
  ok: false,
  link: "off",
  providerFound: false,
  pipeName: PIPE_NAME,
  transport: "Named Pipe → CDP-transport",
};

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
  const [health, setHealth] = useState<HealthInfo>(OFF_HEALTH);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveMode, setSaveMode] = useState<SaveMode>("local");
  const [testing, setTesting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ready, setReady] = useState(false);

  const stopFlag = useRef(false);
  const logId = useRef(1);
  const toastId = useRef(1);
  const saveTimer = useRef<number | undefined>(undefined);
  const docRef = useRef(doc);
  docRef.current = doc;
  const runRef = useRef(run);
  runRef.current = run;

  /* ---------- загрузка графа ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      const { doc: d, mode } = await loadDoc();
      if (!alive) return;
      setDoc(d ?? sampleDiamond());
      setSaveMode(mode);
      setSaveState(d ? "saved" : "idle");
      setReady(true);
    })();
    return () => {
      alive = false;
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

  /* ---------- события локального узла → UI ---------- */
  const handleEvent = useCallback(
    (e: HostEvent) => {
      switch (e.type) {
        case "hello":
          setHealth((h) => ({ ...h, ok: true, link: "on", providerFound: e.providerFound, pipeName: e.pipeName, transport: e.transport }));
          break;
        case "run-start": {
          setRunInfo(new Map());
          setActiveEdges(new Set());
          setRun({ phase: "running", steps: 0, startedAt: Date.now() });
          setLogOpen(true);
          const names = e.roots.map((r) => r.title).join(", ") || "—";
          pushLog(
            "sys",
            `Старт прогона: ${e.totalNodes} узл. Стартовые: ${names}. Сведение ждёт все входы, циклы ограничены ${e.maxSteps} шагами. Промпт/ответ идут через ${PIPE_NAME} → CDP-transport → Qwen.`,
          );
          break;
        }
        case "node-start": {
          setRun((r) => ({ ...r, steps: e.step - 1 }));
          setRunInfo((m) => {
            const n = new Map(m);
            const prev = n.get(e.id);
            n.set(e.id, { status: "running", step: e.step, startedAt: Date.now(), execCount: (prev?.execCount ?? 0) + 1 });
            return n;
          });
          const inc = new Set<string>();
          docRef.current.edges.forEach((ed) => {
            if (ed.to === e.id) inc.add(ed.id);
          });
          setActiveEdges(inc);
          pushLog("step", `Узел «${e.title}» исполняется (шаг ${e.step})…`, e.id, e.step);
          break;
        }
        case "prompt":
          pushLog("prompt", e.prompt, e.id, e.step);
          break;
        case "node-done": {
          setRunInfo((m) => {
            const n = new Map(m);
            const prev = n.get(e.id);
            n.set(e.id, { status: "done", step: e.step, result: e.answer, startedAt: prev?.startedAt, finishedAt: Date.now(), execCount: prev?.execCount ?? 1 });
            return n;
          });
          setActiveEdges(new Set(e.outEdges));
          window.setTimeout(() => setActiveEdges(new Set()), 1500);
          pushLog("answer", e.answer, e.id, e.step);
          pushLog("ok", `«${e.title}» готов за ${(e.elapsedMs / 1000).toFixed(1)} с — результат передан по ${e.outEdges.length} свз.`, e.id, e.step);
          break;
        }
        case "node-error": {
          setRunInfo((m) => {
            const n = new Map(m);
            const prev = n.get(e.id);
            n.set(e.id, { status: "error", step: e.step, error: e.error, finishedAt: Date.now(), execCount: prev?.execCount ?? 1 });
            return n;
          });
          setActiveEdges(new Set());
          pushLog("err", e.error, e.id, e.step);
          break;
        }
        case "step-limit":
          pushLog("err", `Аварийный предел: превышен MAX_STEPS = ${e.maxSteps}. Исполнение остановлено.`);
          setRun({ phase: "error", steps: e.step, finishedAt: Date.now(), message: `Превышен аварийный предел MAX_STEPS = ${e.maxSteps}` });
          break;
        case "done":
          setActiveEdges(new Set());
          setRun({ phase: "done", steps: e.steps, finishedAt: Date.now() });
          pushLog("ok", `Прогон завершён: ${e.steps} шаг(ов). Все результаты — в узлах (правая панель).`);
          toast("ok", `Готово: ${e.steps} шаг(ов)`);
          break;
        case "stopped":
          setActiveEdges(new Set());
          setRun({ phase: "stopped", steps: e.steps, finishedAt: Date.now() });
          pushLog("warn", "Остановлено пользователем. Текущий запрос к Qwen мог дописаться в чат.");
          toast("info", "Прогон остановлен");
          break;
        case "fail":
          setActiveEdges(new Set());
          setRun((r) => ({ phase: "error", steps: r.steps, finishedAt: Date.now(), message: e.message }));
          pushLog("err", e.message);
          toast("err", "Прогон не завершён — детали в журнале");
          break;
        case "test-result":
          if (e.ok && e.answer) {
            pushLog("answer", e.answer);
            pushLog("ok", "Транспорт работает: Qwen ответил через CDP (Named Pipe).");
            toast("ok", "Qwen ответил — транспорт в порядке");
          } else {
            pushLog("err", e.error || "Тест не вернул ответ.");
            toast("err", e.error || "Тест не прошёл");
          }
          setTesting(false);
          break;
      }
    },
    [pushLog, toast],
  );

  /* ---------- канал редактор ↔ локальный узел ---------- */
  useEffect(() => {
    hostLink.onEvent = handleEvent;
    hostLink.onStatus = (s: LinkStatus) => {
      setHealth((h) => ({ ...h, link: s, ok: s === "on" }));
      if (s === "off" && runRef.current.phase === "running") {
        setRun((r) => ({ phase: "error", steps: r.steps, finishedAt: Date.now(), message: "Канал с локальным узлом разорван во время прогона." }));
        pushLog("err", "Канал с локальным узлом разорван.");
      }
    };
    void hostLink.connect();
    const t = window.setInterval(() => {
      if (!hostLink.connected) void hostLink.connect();
    }, 4000);
    return () => {
      window.clearInterval(t);
      hostLink.close();
    };
  }, [handleEvent, pushLog]);

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
    if (!hostLink.connected) {
      const ok = await hostLink.connect();
      if (!ok) {
        pushLog(
          "err",
          `Локальный узел СБОРКИ не отвечает: канал редактора не поднят, Named Pipe ${PIPE_NAME} недоступен. Запустите start.bat из корня репозитория.`,
        );
        toast("err", "Узел не запущен — выполните start.bat");
        return;
      }
    }
    stopFlag.current = false;
    setLogOpen(true);
    const sent = hostLink.run({
      nodes: d.nodes.map((n) => ({ id: n.id, title: n.title, content: n.content })),
      edges: d.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
      maxSteps: MAX_STEPS,
    });
    if (!sent) {
      pushLog("err", "Не удалось передать граф в локальный узел — канал разорван.");
      toast("err", "Канал с узлом разорван");
    }
  }, [running, pushLog, toast]);

  const stopRun = useCallback(() => {
    stopFlag.current = true;
    hostLink.stop();
    pushLog("warn", "Запрошена остановка — узел прервёт прогон после текущего шага.");
  }, [pushLog]);

  /* ---------- тест транспорта ---------- */
  const doTest = useCallback(async () => {
    if (!hostLink.connected) {
      const ok = await hostLink.connect();
      if (!ok) {
        toast("err", "Узел не запущен — выполните start.bat");
        return;
      }
    }
    setTesting(true);
    pushLog("sys", "Тест транспорта: узел отправит «Напиши одно слово: ТЕСТ.» через Named Pipe в существующий CDP-transport.");
    if (!hostLink.test()) {
      setTesting(false);
      pushLog("err", "Не удалось отправить тест в узел — канал разорван.");
      toast("err", "Канал с узлом разорван");
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
