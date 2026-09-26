const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(payload);
}

function staticFileExists(filePath) {
  try {
    return fs.existsSync(filePath)
      && fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

function serveStaticFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  if (!staticFileExists(filePath)) {
    sendText(res, 'Not Found', 404);
    return;
  }

  fs.readFile(filePath, (error, file) => {
    if (error) {
      sendText(res, 'Internal Server Error', 500);
      return;
    }

    res.writeHead(200, { 'Content-Type': mime });
    res.end(file);
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === '/api/health') {
    sendJson(res, { status: 'ok', service: 'PARA admin server' });
    return;
  }

  const normalizedPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const filePath = path.normalize(path.join(ROOT, normalizedPath.replace(/^\//, '')));

  if (!filePath.startsWith(ROOT)) {
    sendText(res, 'Forbidden', 403);
    return;
  }

  serveStaticFile(req, res, filePath);
});

server.listen(PORT, () => {
  console.log(`PARA admin server listening at http://localhost:${PORT}`);
});
