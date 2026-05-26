#!/usr/bin/env node
// Tiny zero-dependency static server for previewing the PWA.
// Serves from the directory above .claude/ (project root).
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = parseInt(process.env.PORT || "8765", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let filePath = path.join(ROOT, urlPath);
    // Prevent escape via ../
    if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden");

    let stat;
    try { stat = fs.statSync(filePath); } catch { return send(res, 404, "Not found"); }

    if (stat.isDirectory()) {
      // Try index.html
      const indexPath = path.join(filePath, "index.html");
      if (fs.existsSync(indexPath)) {
        filePath = indexPath;
      } else if (urlPath === "/") {
        // Redirect root to the app
        return send(res, 302, "", { Location: "/app/" });
      } else {
        // Simple directory listing
        const entries = fs.readdirSync(filePath);
        const links = entries
          .map((e) => `<li><a href="${urlPath.replace(/\/?$/, "/")}${e}">${e}</a></li>`)
          .join("");
        return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Index of ${urlPath}</title><h1>Index of ${urlPath}</h1><ul>${links}</ul>`, { "Content-Type": "text/html; charset=utf-8" });
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const body = fs.readFileSync(filePath);
    send(res, 200, body, { "Content-Type": type });
  } catch (err) {
    send(res, 500, `Server error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Serving ${ROOT} on http://localhost:${PORT}`);
});
