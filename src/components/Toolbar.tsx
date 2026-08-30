import type { HealthInfo, RunPhase } from "../types";
import { IconBolt, IconPlay, IconSave, IconStop } from "./icons";

interface Props {
  projectName: string;
  onRename: (name: string) => void;
  saveState: "idle" | "saving" | "saved";
  saveMode: "server" | "local";
  health: HealthInfo;
  phase: RunPhase;
  onRun: () => void;
  onStop: () => void;
}

export default function Toolbar(p: Props) {
  const running = p.phase === "running";
  return (
    <header className="flex h-[58px] shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
      {/* марка */}
      <div className="flex items-center gap-3">
        <div className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-amber/40 bg-deep">
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
            <circle cx="9" cy="9" r="3.2" fill="#f5a524" />
            <circle cx="24" cy="16" r="3.2" fill="#4dd6e0" />
            <circle cx="9" cy="24" r="3.2" fill="#3fb950" />
            <path d="M12 10.4 20.8 14.8M12 22.6 20.8 17.2" stroke="#8b98a9" strokeWidth="1.7" />
          </svg>
          {running && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber led-run" />}
        </div>
        <div className="leading-none">
          <div className="font-display text-[17px] tracking-[0.14em] text-ink">
            СБОРКА<span className="text-amber">·</span>BP
          </div>
          <div className="mt-1 font-mono text-[9px] tracking-[0.08em] text-dim uppercase">
            BPmanager × CDP-transport × Qwen
          </div>
        </div>
      </div>

      {/* имя проекта */}
      <div className="mx-2 h-7 w-px bg-line" />
      <input
        value={p.projectName}
        onChange={(e) => p.onRename(e.target.value)}
        spellCheck={false}
        className="w-[240px] rounded-md border border-transparent bg-transparent px-2 py-1.5 font-display text-[13px] tracking-wide text-ink/90 transition-colors hover:border-line focus:border-cyan/50 focus:bg-deep focus:outline-none"
        title="Имя проекта (папка в data/)"
      />

      {/* сохранение */}
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-dim">
        <IconSave size={13} className={p.saveState === "saved" ? "text-ok" : "text-dim"} />
        {p.saveState === "saving" ? "сохранение…" : p.saveState === "saved" ? "localStorage" : "—"}
      </div>

      <div className="ml-auto flex items-center gap-2.5">
        {/* транспорт */}
        <div
          className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${
            p.health.ok ? "border-ok/30 bg-ok/8" : "border-err/30 bg-err/8"
          }`}
          title={
            p.health.ok
              ? `Named Pipe: ${p.health.pipeName} · Provider_Qwen.ps1 ${p.health.providerFound ? "найден" : "НЕ найден"} · промпт/ответ — в оперативной памяти`
              : "Локальный узел не запущен — выполните start.bat"
          }
        >
          <span className={`h-2 w-2 rounded-full ${p.health.ok ? "bg-ok" : "bg-err"}`} />
          <span className={`font-mono text-[10.5px] ${p.health.ok ? "text-ok" : "text-err"}`}>
            {p.health.ok ? (p.health.providerFound ? "транспорт готов" : "нет провайдера") : "нет узла"}
          </span>
        </div>

        {running ? (
          <button
            onClick={p.onStop}
            className="btn-bezel flex items-center gap-2 rounded-md bg-err px-5 py-2.5 font-display text-[13px] tracking-[0.12em] text-white uppercase"
          >
            <IconStop size={14} /> Стоп
          </button>
        ) : (
          <button
            onClick={p.onRun}
            className="btn-bezel relative flex items-center gap-2.5 rounded-md bg-gradient-to-b from-amber2 to-amber px-6 py-2.5 font-display text-[14px] tracking-[0.14em] text-[#231603] uppercase"
            title="Прогнать граф через Qwen (Ctrl+Enter)"
          >
            <IconBolt size={15} />
            Исполнить
            <IconPlay size={13} className="opacity-70" />
          </button>
        )}
      </div>
    </header>
  );
}
