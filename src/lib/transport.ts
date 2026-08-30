/* ============================================================
   КАНАЛ РЕДАКТОРА ↔ ЛОКАЛЬНЫЙ УЗЕЛ СБОРКИ.

   Браузер — тонкий клиент. Он НЕ исполняет граф и НЕ ходит в Qwen:
   никаких fetch / http / REST. Единственный канал редактора —
   WebSocket до своего же узла (тот же origin, что отдаёт страницу).

   Сам Qwen-транспорт внутри узла — это Windows Named Pipe
   (\\.\pipe\SborkaQwen): промпт и ответ идут через оперативную
   память в существующий CDP-transport, минуя SSD и HTTP.
   ============================================================ */

export const PIPE_NAME = "\\\\.\\pipe\\SborkaQwen";

export interface HostHello {
  ok: boolean;
  providerFound: boolean;
  pipeName: string;
  transport: string;
}

/* События, которые узел шлёт редактору во время прогона. */
export type HostEvent =
  | { type: "hello"; providerFound: boolean; pipeName: string; transport: string }
  | { type: "run-start"; totalNodes: number; roots: { id: string; title: string }[]; maxSteps: number }
  | { type: "node-start"; id: string; step: number; title: string }
  | { type: "prompt"; id: string; step: number; prompt: string }
  | { type: "node-done"; id: string; step: number; title: string; answer: string; elapsedMs: number; outEdges: string[] }
  | { type: "node-error"; id: string; step: number; title: string; error: string }
  | { type: "step-limit"; step: number; maxSteps: number }
  | { type: "done"; steps: number }
  | { type: "stopped"; steps: number }
  | { type: "fail"; message: string }
  | { type: "test-result"; ok: boolean; answer?: string; error?: string };

export interface RunRequest {
  nodes: { id: string; title: string; content: string }[];
  edges: { id: string; from: string; to: string }[];
  maxSteps: number;
}

type Status = "off" | "connecting" | "on";

class HostLink {
  private ws: WebSocket | null = null;
  private status: Status = "off";
  private pending: Promise<boolean> | null = null;
  onEvent: (e: HostEvent) => void = () => {};
  onStatus: (s: Status) => void = () => {};

  private set(s: Status) {
    this.status = s;
    this.onStatus(s);
  }

  /** Узел отдаёт страницу и WebSocket на одном origin. Повторные вызовы не плодят сокеты. */
  connect(): Promise<boolean> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
    if (this.pending) return this.pending;

    this.pending = new Promise((resolve) => {
      const done = (ok: boolean) => {
        this.pending = null;
        resolve(ok);
      };
      try {
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${window.location.host}/sborka`);
        this.ws = ws;
        this.set("connecting");
        ws.onopen = () => {
          this.set("on");
          done(true);
        };
        const fail = () => {
          this.set("off");
          done(false);
        };
        ws.onerror = fail;
        ws.onclose = () => this.set("off");
        ws.onmessage = (m) => {
          try {
            this.onEvent(JSON.parse(String(m.data)) as HostEvent);
          } catch {
            /* не-JSON — игнорируем */
          }
        };
      } catch {
        this.set("off");
        done(false);
      }
    });
    return this.pending;
  }

  send(msg: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  run(req: RunRequest): boolean {
    return this.send({ type: "run", ...req });
  }
  stop(): boolean {
    return this.send({ type: "stop" });
  }
  test(): boolean {
    return this.send({ type: "test" });
  }

  get connected(): boolean {
    return this.status === "on" && this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.set("off");
  }
}

export const hostLink = new HostLink();
