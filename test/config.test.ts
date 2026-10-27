import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DEFAULTS, loadConfig } from '../src/config.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-config-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, value: unknown) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};

test('merges the file over the defaults', () => {
  const config = loadConfig(write('a.json', { spin: [{ click: [0.5, 0.9] }], timeouts: { round: 30 }, screens: { info: [{ key: 'i' }] } }));
  assert.deepEqual(config.spin, [{ click: [0.5, 0.9] }]);
  assert.equal(config.timeouts.round, 30);
  assert.equal(config.timeouts.load, DEFAULTS.timeouts.load);
  assert.deepEqual(config.screens.info, [{ key: 'i' }]);
});

test('rejects steps it does not know', () => {
  assert.throws(() => loadConfig(write('b.json', { spin: [{ tap: [1, 1] }] })), /should be one of/);
  assert.throws(() => loadConfig(write('c.json', { start: [{ click: [600, 400] }] })), /fractions of the screen/);
  assert.throws(() => loadConfig(write('d.json', '{ nope')), /Can't read/);
  assert.throws(() => loadConfig(write('e.json', { screens: null })), /"screens" should be an object/);
  assert.throws(() => loadConfig(write('f.json', { langs: 'de' })), /"langs" should be a list/);
});

test('rejects math limits it can not use', () => {
  assert.deepEqual(loadConfig(write('g.json', { limits: { rtp: [0.96, 0.97], maxWin: 25000 } })).limits, { rtp: [0.96, 0.97], maxWin: 25000 });
  assert.throws(() => loadConfig(write('h.json', { limits: { rtp: 0.965 } })), /"limits.rtp" should be \[lowest, highest\]/);
  assert.throws(() => loadConfig(write('i.json', { limits: { rtp: [96, 97] } })), /as fractions/);
  assert.throws(() => loadConfig(write('j.json', { limits: { maxWin: '25000' } })), /"limits.maxWin" should be a number/);
  assert.throws(() => loadConfig(write('k.json', { limits: [0.96, 0.97] })), /"limits" should be an object/);
});
