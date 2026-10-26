import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

/**
 * Serves the build the way Stake's CDN does: static files under /<game>/<version>/ and nothing above
 * that folder. Range requests are answered, so video and audio load the way they do in production.
 * @param {string} dir the build folder
 * @param {string} prefix the folder it's served under, e.g. "/my-game/1/"
 * @param {Set<string>} [files] the build's files (relative, "/"-separated). When given, a path has to
 *   match one exactly: the CDN is case-sensitive even where the local disk isn't.
 */
export async function serveBuild(dir, prefix, files) {
  const root = path.resolve(dir);

  const server = http.createServer((req, res) => {
    const reply = (status, headers = {}) => {
      res.writeHead(status, headers);
      res.end();
    };
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return reply(400);
    }
    if (pathname.includes('\0')) return reply(400);
    if (!pathname.startsWith(prefix)) return reply(404);

    let relative = pathname.slice(prefix.length);
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const file = path.join(root, relative);
    const inside = path.relative(root, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return reply(404);
    if (files && !files.has(inside.split(path.sep).join('/'))) return reply(404);

    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) return reply(404);
      const headers = {
        'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
      };
      const range = parseRange(req.headers.range, stat.size);
      if (range === null) return reply(416, { 'content-range': `bytes */${stat.size}` });

      const { start = 0, end = stat.size - 1 } = range ?? {};
      if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['content-length'] = stat.size === 0 ? 0 : end - start + 1;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || stat.size === 0) return res.end();
      fs.createReadStream(file, { start, end })
        .on('error', () => res.destroy())
        .pipe(res);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The byte range a Range header asks for: `undefined` when there is none, `null` when it can't be served. */
export function parseRange(header, size) {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}
