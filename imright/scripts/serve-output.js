#!/usr/bin/env node
/**
 * Minimal HTTP server for tabloid output. Enables fetch() for counterargs polling.
 * Serves from tabloid_generator/ so /output/slug.html and /counterarguments/slug.json work.
 *
 * Usage: node imright/scripts/serve-output.js [port]
 * Default port: 3757
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../tabloid_generator');
const PORT = parseInt(process.argv[2] || '3757', 10);

const MIME = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url?.split('?')[0] || '/';
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|$))+/, '');
  const filePath = path.join(ROOT, safePath);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${PORT}\n`);
});
