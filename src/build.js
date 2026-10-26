import fs from 'node:fs';
import path from 'node:path';
import { formatBytes, plural } from './util.js';

const SECRET = /(^|\/)(\.env(\..+)?|\.npmrc|id_rsa)$|\.(pem|key|p12)$/i;
const STRAY = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(psd|ai|blend|fla|aep|zip|rar|7z|log)$/i;

/**
 * Checks the build folder itself, before anything runs: the files in it and how index.html and the
 * stylesheets load things. Returns what's in it, or null when there's no index.html.
 */
export async function checkBuild(dir, findings) {
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) {
    findings.error('build/index', `No index.html in ${dir}`, { detail: 'Stake opens <game>/<version>/index.html.' });
    return null;
  }

  const files = [];
  for (const entry of await fs.promises.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    files.push({ path: path.relative(root, file).split(path.sep).join('/'), size: (await fs.promises.stat(file)).size });
  }
  const bytes = files.reduce((sum, file) => sum + file.size, 0);

  const secrets = files.filter((file) => SECRET.test(file.path));
  if (secrets.length) {
    findings.error('build/secret', `The build has ${list(secrets)}`, { detail: 'Files like these hold keys and credentials. Leave them out of the upload.' });
  }
  const stray = files.filter((file) => STRAY.test(file.path));
  if (stray.length) findings.warn('build/stray', `Files that don't belong in a build: ${list(stray)}`);
  const maps = files.filter((file) => file.path.endsWith('.map'));
  if (maps.length) {
    const size = maps.reduce((sum, file) => sum + file.size, 0);
    findings.info('build/sourcemaps', `${plural(maps.length, 'source map')} (${formatBytes(size)}) in the build`, {
      detail: 'Anyone who opens the game can read the original source. Fine if that is intended.',
    });
  }

  const html = await fs.promises.readFile(index, 'utf8');
  checkHtml(html, findings);
  for (const file of files.filter((item) => item.path.endsWith('.css'))) {
    checkCss(file.path, await fs.promises.readFile(path.join(root, file.path), 'utf8'), findings);
  }

  return {
    title: /<title>([^<]*)<\/title>/i.exec(html)?.[1].trim() || null,
    files: files.length,
    bytes,
    biggest: [...files].sort((a, b) => b.size - a.size).slice(0, 5),
    paths: files.map((file) => file.path),
  };
}

const ROOT_PATH = 'Stake serves a game from /<game>/<version>/, so a path that starts with "/" misses it. Use a relative path.';
const EXTERNAL = 'Everything has to ship inside the build; requests to other hosts are blocked.';

const isRootPath = (value) => /^\/(?!\/)/.test(value);
const isExternal = (value) => /^(https?:)?\/\//i.test(value);

function checkHtml(html, findings) {
  const attribute = /<(\w+)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const [, tag, double, single, bare] of html.matchAll(attribute)) {
    if (tag.toLowerCase() === 'a') continue;
    const value = double ?? single ?? bare;
    if (isRootPath(value)) findings.error('build/root-path', `index.html loads "${value}"`, { detail: ROOT_PATH });
    else if (isExternal(value)) findings.error('build/external', `index.html loads ${value}`, { detail: EXTERNAL });
  }
  if (/<base\b[^>]*\bhref\s*=\s*["']?\/["'\s>]/i.test(html)) {
    findings.error('build/base', 'index.html has <base href="/">, which sends every relative path to the server root', { detail: ROOT_PATH });
  }
}

function checkCss(name, css, findings) {
  const loads = [
    ...[...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((match) => match[1]),
    ...[...css.matchAll(/@import\s+["']([^"']+)["']/gi)].map((match) => match[1]),
  ];
  for (const value of loads) {
    if (isRootPath(value)) findings.error('build/root-path', `${name} loads "${value}"`, { detail: ROOT_PATH });
    else if (isExternal(value)) findings.error('build/external', `${name} loads ${value}`, { detail: EXTERNAL });
  }
}

const list = (files) => {
  const names = files.slice(0, 5).map((file) => file.path);
  return files.length > 5 ? `${names.join(', ')} and ${files.length - 5} more` : names.join(', ');
};
