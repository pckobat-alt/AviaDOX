import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WWW_DIR = path.join(__dirname, 'www');
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Ensure bundled Supabase UMD exists in www/vendor for offline & web preview
const supabaseSrc = path.join(__dirname, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
const supabaseDst = path.join(WWW_DIR, 'vendor', 'supabase.umd.js');
try {
  if (!fs.existsSync(supabaseDst) && fs.existsSync(supabaseSrc)) {
    fs.mkdirSync(path.dirname(supabaseDst), { recursive: true });
    fs.copyFileSync(supabaseSrc, supabaseDst);
  }
} catch (err) {
  console.warn('Could not copy supabase.umd.js:', err.message);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.gpx': 'application/gpx+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const resolved = path.resolve(WWW_DIR, '.' + pathname);
  if (resolved !== WWW_DIR && !resolved.startsWith(WWW_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let filePath = resolved;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal Server Error');
  });
  stream.pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`AviaDoX dev server running at http://${HOST}:${PORT}`);
});
