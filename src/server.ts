import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const TYPES: Record<string, string> = {
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
export async function serveBuild(dir: string, prefix: string, files?: Set<string>): Promise<{ origin: string; close(): Promise<void> }> {
  const root = path.resolve(dir);

  const server = http.createServer((req, res) => {
    const reply = (status: number, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, headers);
      res.end();
    };
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
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
      const headers: http.OutgoingHttpHeaders = {
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The byte range a Range header asks for: `undefined` when there is none, `null` when it can't be served. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
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
