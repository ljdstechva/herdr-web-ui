import { describe, expect, it } from "bun:test";
import { DownloadManager, MAX_TRACKED_DOWNLOAD_BYTES } from "./downloads.ts";

class Request {
  status = 200;
  response: Blob | null = null;
  responseType = "";
  onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  url = "";
  aborted = false;
  readyState = 0;
  length: string | null = null;
  onreadystatechange: (() => void) | null = null;
  getResponseHeader() { return this.length; }
  open(_method: string, url: string) { this.url = url; }
  send() {}
  abort() { this.aborted = true; this.onabort?.(); }
  progress(loaded: number, total = 0) { this.onprogress?.({ loaded, total, lengthComputable: total > 0 }); }
  finish(text = "file bytes") { this.response = new Blob([text]); this.onload?.(); }
}
function fixture() {
  const requests: Request[] = [];
  const saved: Array<{ data: Blob | string; name: string }> = [];
  const manager = new DownloadManager({ request: () => {
    const request = new Request(); requests.push(request); return request as unknown as XMLHttpRequest;
  }, save: (data, name) => { saved.push({ data, name }); } });
  return { manager, requests, saved };
}
const source = { url: "/api/fs/file?path=report.pdf&download=1", name: "report.pdf", size: 10 };

describe("downloads", () => {
  it("reports actual progress, minimizes without aborting, and saves the received file once", async () => {
    const { manager, requests, saved } = fixture();
    const id = manager.start(source);
    expect(manager.read().items[0]).toMatchObject({ id, status: "downloading", received: 0, total: null });
    requests[0]!.progress(4, 10);
    expect(manager.read().items[0]).toMatchObject({ received: 4, total: 10 });
    manager.minimize();
    expect(manager.read().minimized).toBe(true);
    expect(requests[0]!.aborted).toBe(false);
    requests[0]!.finish();
    expect(manager.read().items[0]).toMatchObject({ status: "sent", received: 10, total: 10 });
    expect(manager.read().minimized).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("report.pdf");
    expect(await (saved[0]!.data as Blob).text()).toBe("file bytes");
    requests[0]!.onload?.();
    expect(saved).toHaveLength(1);
    manager.show(); expect(manager.read().minimized).toBe(false);
  });
  it("does not invent a total for chunked transfers or save an HTTP error body", () => {
    const { manager, requests, saved } = fixture();
    manager.start(source); requests[0]!.progress(5);
    expect(manager.read().items[0]).toMatchObject({ received: 5, total: null });
    requests[0]!.status = 404; requests[0]!.finish('{"error":{}}');
    expect(manager.read().items[0]?.status).toBe("failed"); expect(saved).toHaveLength(0);
  });
  it("cancel and retry keep late replies harmless and the original remote target", () => {
    const { manager, requests, saved } = fixture();
    const remote = { ...source, url: "/api/machines/remote-one/fs/file?path=report.pdf&download=1" };
    const id = manager.start(remote);
    manager.cancel(id);
    expect(manager.read().items[0]?.status).toBe("cancelled");
    expect(requests[0]!.aborted).toBe(true);
    manager.retry(id);
    expect(requests[1]!.url).toBe(remote.url);
    requests[0]!.finish("stale"); requests[0]!.onerror?.();
    expect(manager.read().items[0]?.status).toBe("downloading"); expect(saved).toHaveLength(0);
    requests[1]!.finish(); expect(saved).toHaveLength(1);
  });
  it("reopens one active transfer instead of starting duplicates", () => {
    const { manager, requests } = fixture();
    const id = manager.start(source); manager.minimize();
    expect(manager.start(source)).toBe(id);
    expect(requests).toHaveLength(1); expect(manager.read().items).toHaveLength(1);
    expect(manager.read().minimized).toBe(false);
    manager.dismiss(id); expect(manager.read().items).toHaveLength(1);
    manager.cancel(id); manager.dismiss(id); expect(manager.read().items).toHaveLength(0);
  });
  it("hands large and unexpectedly growing files to the browser without claiming completion", () => {
    const { manager, requests, saved } = fixture();
    manager.start({ ...source, size: MAX_TRACKED_DOWNLOAD_BYTES + 1 });
    expect(requests).toHaveLength(0); expect(saved[0]?.data).toBe(source.url);
    expect(manager.read().items[0]?.status).toBe("browser");
    manager.start({ ...source, url: source.url + "&second=1" });
    requests[0]!.progress(1, MAX_TRACKED_DOWNLOAD_BYTES + 1);
    expect(requests[0]!.aborted).toBe(true);
    expect(manager.read().items[1]?.status).toBe("browser"); expect(saved).toHaveLength(2);
  });
  it("makes network failures retryable and never saves after leaving the app", () => {
    const { manager, requests, saved } = fixture();
    const id = manager.start(source); requests[0]!.onerror?.();
    expect(manager.read().items[0]?.status).toBe("failed");
    manager.retry(id); manager.cancelAll(); requests[1]!.finish();
    expect(manager.read().items[0]?.status).toBe("cancelled"); expect(saved).toHaveLength(0);
  });
  it("reserves blob bytes until the browser handoff releases them", () => {
    const requests: Request[] = [];
    const releases: Array<() => void> = [];
    let revoked = 0;
    const manager = new DownloadManager({ request: () => {
      const request = new Request(); requests.push(request); return request as unknown as XMLHttpRequest;
    }, save: () => () => { revoked++; }, schedule: run => { releases.push(run); } });
    manager.start(source); requests[0]!.finish();
    const next = manager.start({ ...source, url: source.url + "&next=1", size: MAX_TRACKED_DOWNLOAD_BYTES });
    expect(requests).toHaveLength(1);
    expect(manager.read().items[1]).toMatchObject({ status: "failed", failure: "busy" });
    releases[0]!();
    expect(revoked).toBe(1);
    manager.retry(next);
    expect(requests).toHaveLength(2);
    manager.clear();
    releases[0]!();
    expect(revoked).toBe(1);
    expect(manager.read().items).toHaveLength(0);
  });
  it("hands off oversized headers before buffering and saves a zero-byte file", () => {
    const { manager, requests, saved } = fixture();
    manager.start(source);
    requests[0]!.readyState = 2; requests[0]!.length = String(MAX_TRACKED_DOWNLOAD_BYTES + 1);
    requests[0]!.onreadystatechange?.();
    expect(requests[0]!.aborted).toBe(true);
    expect(saved[0]!.data).toBe(source.url);
    manager.start({ ...source, url: source.url + "&empty=1", size: 0 }); requests[1]!.finish("");
    expect((saved[1]!.data as Blob).size).toBe(0);
    expect(manager.read().items[1]).toMatchObject({ status: "sent", received: 0, total: 0 });
  });
  it("reserves response header sizes before either transfer reports progress", () => {
    const { manager, requests, saved } = fixture();
    manager.start(source);
    requests[0]!.readyState = 2; requests[0]!.length = String(100 * 1024 * 1024); requests[0]!.onreadystatechange?.();
    manager.start({ ...source, url: source.url + "&second=1" });
    requests[1]!.readyState = 2; requests[1]!.length = String(100 * 1024 * 1024); requests[1]!.onreadystatechange?.();
    expect(requests[1]!.aborted).toBe(true);
    expect(saved).toHaveLength(1);
    expect(manager.read().items[1]?.status).toBe("browser");
    expect(manager.read().items[0]?.status).toBe("downloading");
  });
  it("bounds concurrent transfers and finished history without cancelling active downloads", () => {
    const { manager, requests } = fixture();
    for (let index = 0; index < 4; index++) manager.start({ ...source, url: `${source.url}&n=${index}` });
    expect(requests).toHaveLength(3);
    expect(manager.read().items[3]).toMatchObject({ status: "failed", failure: "busy" });
    manager.cancelAll();
    for (let index = 0; index < 12; index++) {
      manager.start({ ...source, url: `${source.url}&done=${index}` }); requests.at(-1)!.finish();
    }
    expect(manager.read().items.length).toBeLessThanOrEqual(10);
  });
});
