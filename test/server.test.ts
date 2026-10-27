import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parseRange, serveBuild } from '../src/server.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-server-'));
fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
fs.mkdirSync(path.join(dir, 'assets'));
fs.writeFileSync(path.join(dir, 'assets', 'clip.mp4'), Buffer.from('0123456789'));

let server: Awaited<ReturnType<typeof serveBuild>>;
let strict: Awaited<ReturnType<typeof serveBuild>>;
before(async () => {
  server = await serveBuild(dir, '/game/1/');
  strict = await serveBuild(dir, '/game/1/', new Set(['index.html', 'assets/clip.mp4']));
});
after(async () => {
  await server.close();
  await strict.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('serves the build under its folder only', async () => {
  const page = await fetch(`${server.origin}/game/1/index.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.equal((await fetch(`${server.origin}/game/1/`)).status, 200);
  assert.equal((await fetch(`${server.origin}/index.html`)).status, 404);
  assert.equal((await fetch(`${server.origin}/game/1/missing.png`)).status, 404);
  assert.equal((await fetch(`${server.origin}/game/1/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
});

test('answers range requests', async () => {
  const part = await fetch(`${server.origin}/game/1/assets/clip.mp4`, { headers: { range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await part.text(), '2345');
  const bad = await fetch(`${server.origin}/game/1/assets/clip.mp4`, { headers: { range: 'bytes=20-' } });
  assert.equal(bad.status, 416);
});

test('parses range headers', () => {
  assert.equal(parseRange(undefined, 10), undefined);
  assert.deepEqual(parseRange('bytes=0-', 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=4-100', 10), { start: 4, end: 9 });
  assert.equal(parseRange('bytes=5-2', 10), null);
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
});

test('matches file names exactly, the way the CDN does', async () => {
  assert.equal((await fetch(`${strict.origin}/game/1/assets/clip.mp4`)).status, 200);
  assert.equal((await fetch(`${strict.origin}/game/1/assets/CLIP.mp4`)).status, 404);
  assert.equal((await fetch(`${strict.origin}/game/1/index.html%00.png`)).status, 400);
});
