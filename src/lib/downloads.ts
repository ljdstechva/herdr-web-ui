/** Downloads belong to this tab, independently of the file preview or selected PC. */
export const MAX_TRACKED_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAX_ACTIVE = 3;
const MAX_HISTORY = 10;
export interface DownloadSource { url: string; name: string; size: number }
export interface DownloadItem extends DownloadSource {
  id: string;
  status: "downloading" | "sent" | "failed" | "cancelled" | "browser";
  received: number;
  total: number | null;
  failure?: "network" | "http" | "busy";
}
interface DownloadIO {
  request: () => XMLHttpRequest;
  /** A blob handoff returns the cleanup that releases its retained bytes. */
  save: (data: Blob | string, name: string) => void | (() => void);
  schedule?: (run: () => void, ms: number) => void;
}

/** The browser owns the final save. A successful click is not proof of a file on disk. */
function saveInBrowser(data: Blob | string, name: string): void | (() => void) {
  // Blob URLs do not carry the file endpoint's sandbox CSP. Force download-only bytes
  // so HTML/SVG cannot become an active same-origin document if a browser opens the URL.
  const url = typeof data === "string" ? data : URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.target = "_blank"; link.rel = "noopener";
  document.body.appendChild(link);
  try { link.click(); }
  catch (error) { if (typeof data !== "string") URL.revokeObjectURL(url); throw error; }
  finally { link.remove(); }
  if (typeof data !== "string") return () => URL.revokeObjectURL(url);
}

export class DownloadManager {
  private snapshot: { items: readonly DownloadItem[]; minimized: boolean } = { items: [], minimized: false };
  private listeners = new Set<() => void>();
  private requests = new Map<string, XMLHttpRequest>();
  private sequence = 0;
  private retained = new Set<{ bytes: number; release: () => void }>();
  constructor(private readonly io: DownloadIO = { request: () => new XMLHttpRequest(), save: saveInBrowser }) {}

  read = () => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(items = this.snapshot.items, minimized = this.snapshot.minimized): void {
    this.snapshot = { items, minimized };
    for (const listener of this.listeners) listener();
  }
  private patch(id: string, change: Partial<DownloadItem>): void {
    this.publish(this.snapshot.items.map(item => item.id === id ? { ...item, ...change } : item));
  }
  private release(id: string, abort = false): void {
    const request = this.requests.get(id);
    this.requests.delete(id);
    if (!request) return;
    request.onload = request.onprogress = request.onerror = request.onabort = request.ontimeout = request.onreadystatechange = null;
    if (abort) request.abort();
  }
  private budget(except?: string): number {
    const held = [...this.retained].reduce((sum, allocation) => sum + allocation.bytes, 0);
    return this.snapshot.items.filter(item => item.id !== except && item.status === "downloading")
      .reduce((sum, item) => sum + Math.max(item.received, item.total ?? item.size), held);
  }

  start(source: DownloadSource): string {
    const active = this.snapshot.items.find(item => item.url === source.url && item.status === "downloading");
    if (active) { this.show(); return active.id; }
    const id = `download-${++this.sequence}`;
    const items = [...this.snapshot.items];
    while (items.length >= MAX_HISTORY) {
      const old = items.findIndex(item => item.status !== "downloading");
      if (old < 0) break;
      items.splice(old, 1);
    }
    const item: DownloadItem = { ...source, size: Math.max(0, source.size), id, status: "downloading", received: 0, total: null };
    this.publish([...items, item], false);
    if (source.size > MAX_TRACKED_DOWNLOAD_BYTES) { this.browser(id); return id; }
    if (this.requests.size >= MAX_ACTIVE || this.budget() > MAX_TRACKED_DOWNLOAD_BYTES) {
      this.patch(id, { status: "failed", failure: "busy" }); return id;
    }
    let request: XMLHttpRequest;
    try { request = this.io.request(); }
    catch { this.patch(id, { status: "failed", failure: "network" }); return id; }
    this.requests.set(id, request);
    const current = () => this.requests.get(id) === request;
    const fail = (failure: "network" | "http") => {
      if (!current()) return;
      this.release(id); this.patch(id, { status: "failed", failure });
    };
    const tooLarge = (bytes: number) => bytes + this.budget(id) > MAX_TRACKED_DOWNLOAD_BYTES;
    request.onreadystatechange = () => {
      if (!current() || request.readyState !== 2 || request.status !== 200) return;
      const header = request.getResponseHeader("content-length");
      const length = header?.trim() ? Number(header) : NaN;
      if (!Number.isFinite(length) || length < 0) return;
      if (tooLarge(length)) this.browser(id);
      else this.patch(id, { size: Math.max(item.size, length), total: length > 0 ? length : null });
    };
    request.onprogress = event => {
      if (!current()) return;
      const received = Math.max(0, event.loaded);
      const total = event.lengthComputable && event.total > 0 ? event.total : null;
      if (tooLarge(Math.max(received, total ?? 0))) { this.browser(id); return; }
      this.patch(id, { received, total });
    };
    request.onload = () => {
      if (!current()) return;
      if (request.status !== 200 || !(request.response instanceof Blob)) { fail("http"); return; }
      const blob: Blob = request.response;
      if (tooLarge(blob.size)) { this.browser(id); return; }
      this.release(id);
      try {
        const release = this.io.save(blob, item.name);
        if (release) {
          const allocation = { bytes: blob.size, release: () => {
            if (!this.retained.delete(allocation)) return;
            release();
          } };
          this.retained.add(allocation);
          // Give the browser time to claim the blob, counting it against the same memory budget.
          (this.io.schedule ?? ((run, ms) => { setTimeout(run, ms); }))(allocation.release, 60_000);
        }
        this.patch(id, { status: "sent", received: blob.size, total: blob.size });
      } catch { this.patch(id, { status: "failed", failure: "network" }); }
    };
    request.onerror = request.ontimeout = () => fail("network");
    request.onabort = () => { if (current()) { this.release(id); this.patch(id, { status: "cancelled" }); } };
    try {
      request.open("GET", source.url);
      request.responseType = "blob";
      request.send();
    } catch { fail("network"); }
    return id;
  }
  minimize(): void { this.publish(undefined, true); }
  show(): void { this.publish(undefined, false); }
  cancel(id: string): void {
    if (!this.requests.has(id)) return;
    this.release(id, true); this.patch(id, { status: "cancelled" });
  }
  dismiss(id: string): void {
    this.publish(this.snapshot.items.filter(item => item.id !== id || item.status === "downloading"));
  }
  retry(id: string): void {
    const item = this.snapshot.items.find(item => item.id === id);
    if (!item || item.status === "downloading") return;
    this.dismiss(id); this.start({ url: item.url, name: item.name, size: item.size });
  }
  /** Large files stay streamed by the browser, outside the page's bounded blob transfers. */
  browser(id: string): void {
    const item = this.snapshot.items.find(item => item.id === id);
    if (!item) return;
    this.release(id, true);
    this.patch(id, { status: "browser", total: null });
    try { this.io.save(item.url, item.name); }
    catch { this.patch(id, { status: "failed", failure: "network" }); }
  }
  cancelAll(): void { for (const id of [...this.requests.keys()]) this.cancel(id); }
  clear(): void {
    this.cancelAll();
    for (const allocation of this.retained) allocation.release();
    this.publish([], false);
  }
}

export const downloads = new DownloadManager();
