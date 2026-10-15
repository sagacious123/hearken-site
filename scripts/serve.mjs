// Serves dist/ like Vercel does (clean URLs: /blog → blog.html), for checking before a push.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".js": "text/javascript" };
const port = Number(process.env.PORT) || 4321;

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const tries = path.endsWith("/") ? [join(path, "index.html")] : [path, `${path}.html`];
  for (const t of tries) {
    try {
      const body = await readFile(join("dist", t));
      res.writeHead(200, { "Content-Type": TYPES[extname(t)] ?? "application/octet-stream" });
      return res.end(body);
    } catch {}
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
}).listen(port, () => console.log(`http://localhost:${port}`));
