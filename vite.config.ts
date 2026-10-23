import { buildXtermSource } from "./scripts/build-xterm.ts";
import { defineConfig, normalizePath, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const xtermSource = normalizePath(buildXtermSource(fileURLToPath(new URL(".", import.meta.url))));

let revision: string | null = null;
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* non-Git build */ }

// agentSvgMarks.ts carries LobeHub Icons paths (MIT): their notice ships with every built client
const thirdPartyNotices: Plugin = {
  name: "third-party-notices",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source: readFileSync("THIRD_PARTY_NOTICES.md", "utf8") });
  },
};

// pdf.js reads data of its own at run time (src/lib/pdf.ts): the CMaps of CJK text, the standard
// fonts a PDF may leave out, and the JavaScript decoders of scanned images (JBIG2, JPEG 2000, fax),
// with their licenses. They ship under /assets/pdfjs-<version>/: a versioned folder, cached like
// the bundles, which src/lib/pdf.ts finds beside its own chunk.
const pdfjsRoot = fileURLToPath(new URL("./node_modules/pdfjs-dist/", import.meta.url));
const pdfjsFolder = `pdfjs-${(JSON.parse(readFileSync(join(pdfjsRoot, "package.json"), "utf8")) as { version: string }).version}/`;
function pdfjsData(): Map<string, string> {
  const files = new Map<string, string>();
  for (const folder of ["cmaps", "standard_fonts"]) {
    for (const name of readdirSync(join(pdfjsRoot, folder))) files.set(`${folder}/${name}`, join(pdfjsRoot, folder, name));
  }
  // only the JavaScript decoders: the app's CSP has no 'wasm-unsafe-eval', so the .wasm builds would never load
  for (const name of readdirSync(join(pdfjsRoot, "wasm"))) {
    if (name.endsWith("_nowasm_fallback.js") || name.startsWith("LICENSE")) files.set(`wasm/${name}`, join(pdfjsRoot, "wasm", name));
  }
  return files;
}
const pdfjsAssets: Plugin = {
  name: "pdfjs-data",
  configureServer(server) {
    const files = pdfjsData();
    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? "").split("?")[0]!;
      const at = path.indexOf(`/${pdfjsFolder}`);
      const file = at === -1 ? undefined : files.get(decodeURIComponent(path.slice(at + pdfjsFolder.length + 1)));
      if (file === undefined) { next(); return; }
      response.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
      response.end(readFileSync(file));
    });
  },
  generateBundle() {
    for (const [name, file] of pdfjsData()) this.emitFile({ type: "asset", fileName: `assets/${pdfjsFolder}${name}`, source: readFileSync(file) });
  },
};

export default defineConfig({
  plugins: [react(), thirdPartyNotices, pdfjsAssets],
  define: {
    __APP_REVISION__: JSON.stringify(revision),
    __APP_VERSION__: JSON.stringify((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version),
    __PDFJS_DATA__: JSON.stringify(pdfjsFolder),
  },
  server: {
    port: 5173,
    proxy: {
      // ws: the browser view's stream is a WebSocket under /api
      "/api": { target: "http://localhost:7317", ws: true },
      "/ws": { target: "ws://localhost:7317", ws: true },
    },
  },
  build: { outDir: "dist" },
  // The Bun patch targets xterm's readable source, not its minified distribution. Build that
  // source so dev, production and the website use the same reviewed IME backport.
  resolve: { alias: [
    { find: /^@xterm\/xterm$/, replacement: `${xtermSource}/browser/public/Terminal.js` },
    { find: /^browser\//, replacement: `${xtermSource}/browser/` },
    { find: /^common\//, replacement: `${xtermSource}/common/` },
    { find: "@shared", replacement: new URL("./shared", import.meta.url).pathname },
  ] },
});
