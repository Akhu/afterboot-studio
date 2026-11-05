import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStudio, ambienceInput } from '../server.mjs';
import { renderTexture } from '../audio-effects.mjs';

const input = { model: 'small-music', title: 'Clouds', prompt: 'Ethereal pads', duration: 5, seed: 42, randomSeed: false, background: { type: 'pink', levelDb: -32 }, ending: { seconds: 3 } };
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
const post = async (base, path, body = {}) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
test('ambiences validate 5–120 s, both models, seeds and independent noise controls', () => {
  for (const model of ['small-music', 'small-sfx']) for (const duration of [5, 120]) {
    assert.equal(ambienceInput({ ...input, model, duration }).model, model);
  }
  for (const patch of [{ duration: 4 }, { duration: 121 }, { duration: 5.1 }, { model: 'medium' }, { seed: -1 }, { seed: 2 ** 31 }, { randomSeed: 'false' }, { prompt: '' }, { background: { type: 'purple' } }, { ending: { seconds: 16 } }]) {
    assert.throws(() => ambienceInput({ ...input, ...patch }));
  }
  assert.ok(Number.isInteger(ambienceInput({ ...input, randomSeed: true }).seed));
});

test('simulated model + real FFmpeg: shared library, original, metadata, favorites and cross-engine exclusion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterboot-ambience-'));
  let release, began, running = 0, maxRunning = 0, busyACE = false, rendered = 0;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const ace = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { queue_size: 0, jobs: { running: busyACE ? 1 : 0, queued: 0 } } }));
  });
  let studio;
  try {
    const engineURL = await listen(ace);
    studio = createStudio({ engineURL, dataDir: directory, getAmbienceStatus: () => ({ installed: true, validated: true }), ambienceRenderer: async (track, dir, phase) => {
      running++; maxRunning = Math.max(maxRunning, running); rendered++; began();
      await gate; phase('generating');
      const audioFile = track.id + '.wav';
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=5', '-ar', '44100', '-ac', '2', join(dir, 'audio', audioFile)]);
      running--; return { audioFile, returnedSeed: track.input.seed };
    } });
    const base = await listen(studio);
    busyACE = true;
    assert.equal((await post(base, '/api/ambiences/generate', input)).status, 409);
    busyACE = false;
    const created = await post(base, '/api/ambiences/generate', input);
    assert.equal(created.status, 202); await started;
    assert.equal(created.data.input.engine, 'stable-audio-3');
    assert.match(created.data.generationPrompt, /No drums/);
    assert.equal((await post(base, '/api/ambiences/generate', { ...input, model: 'small-sfx' })).status, 409);
    assert.equal((await post(base, '/api/generate', { prompt: 'Music', duration: 60, bpm: 120, randomSeed: false, seed: 1, thinking: false, format: 'wav' })).status, 409);
    release();
    let track;
    for (let attempt = 0; attempt < 100; attempt++) {
      track = (await post(base, '/api/tracks/' + created.data.id + '/refresh')).data;
      if (track.status !== 'pending') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(track.status, 'ready');
    assert.equal(maxRunning, 1); assert.equal(rendered, 1);
    assert.equal(track.audioFormat, 'wav'); assert.ok(track.originalAudioURL);
    const original = Buffer.from(await (await fetch(base + track.originalAudioURL)).arrayBuffer());
    const processed = Buffer.from(await (await fetch(base + track.audioURL)).arrayBuffer());
    assert.notDeepEqual(original, processed);
    assert.deepEqual(original, readFileSync(join(directory, 'audio', track.id + '.wav')));
    assert.equal((await post(base, '/api/tracks/' + track.id + '/favorite')).data.favorite, true);
    const metadata = await (await fetch(base + '/api/tracks/' + track.id + '/metadata')).json();
    assert.equal(metadata.input.model, 'small-music'); assert.equal(metadata.input.seed, 42);
    assert.equal(metadata.texture.background.levelDb, -32);
    const sfx = await post(base, '/api/ambiences/generate', { ...input, model: 'small-sfx', background: { type: 'off' }, ending: { seconds: 0 } });
    assert.match(sfx.data.generationPrompt, /No music/);
    while ((await post(base, '/api/tracks/' + sfx.data.id + '/refresh')).data.status === 'pending') await new Promise(resolve => setTimeout(resolve, 10));
    await close(studio);
    studio = createStudio({ dataDir: directory });
    const restarted = await listen(studio);
    const tracks = await (await fetch(restarted + '/api/tracks')).json();
    assert.equal(tracks.length, 2); assert.equal(tracks[1].favorite, true); assert.equal(tracks[1].status, 'ready');
  } finally { if (studio) await close(studio); await close(ace); rmSync(directory, { recursive: true, force: true }); }
});

test('restart marks interrupted local processes failed without resubmitting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterboot-ambience-restart-'));
  writeFileSync(join(directory, 'library.json'), JSON.stringify([{ id: 'interrupted', input: ambienceInput(input), status: 'pending' }]));
  const studio = createStudio({ dataDir: directory });
  try {
    const base = await listen(studio);
    const track = (await (await fetch(base + '/api/tracks')).json())[0];
    assert.equal(track.status, 'failed'); assert.equal(track.errorCode, 'errorAmbienceInterrupted');
  } finally { await close(studio); rmSync(directory, { recursive: true, force: true }); }
});

test('archived Stable Audio retries failed FFmpeg processing after restart without regenerating', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterboot-ambience-reprocess-'));
  const { mkdirSync } = await import('node:fs'); mkdirSync(join(directory, 'audio'));
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=5', '-ar', '44100', '-ac', '2', join(directory, 'audio', 'saved.wav')]);
  const original = readFileSync(join(directory, 'audio', 'saved.wav'));
  writeFileSync(join(directory, 'library.json'), JSON.stringify([{ id: 'archived', input: ambienceInput(input), audioFile: 'saved.wav', status: 'pending' }]));
  let calls = 0, generated = 0;
  const studio = createStudio({ dataDir: directory, ambienceRenderer: async () => { generated++; throw new Error('Must not regenerate'); }, textureRenderer: async (...args) => {
    if (++calls === 1) throw new Error('Temporary FFmpeg failure');
    return renderTexture(...args);
  } });
  try {
    const base = await listen(studio);
    assert.equal((await post(base, '/api/tracks/archived/refresh')).status, 502);
    const ready = await post(base, '/api/tracks/archived/refresh');
    assert.equal(ready.data.status, 'ready'); assert.ok(ready.data.originalAudioURL);
    assert.equal(generated, 0); assert.equal(calls, 2);
    assert.deepEqual(readFileSync(join(directory, 'audio', 'saved.wav')), original);
  } finally { await close(studio); rmSync(directory, { recursive: true, force: true }); }
});

test('missing installation, unvalidated acceleration and failed takes return useful errors without retrying', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterboot-ambience-errors-'));
  let installed = false, validated = false, calls = 0;
  const ace = createServer((req, res) => res.end(JSON.stringify({ queue_size: 0, jobs: { running: 0, queued: 0 } })));
  let studio;
  try {
    const engineURL = await listen(ace);
    studio = createStudio({ dataDir: directory, engineURL, getAmbienceStatus: () => ({ installed, validated }), ambienceRenderer: async () => {
      calls++; throw Object.assign(new Error('denied'), { code: 'errorAmbienceAuth', status: 503 });
    } });
    const base = await listen(studio);
    assert.equal((await post(base, '/api/ambiences/generate', input)).data.errorCode, 'errorAmbienceInstall');
    installed = true;
    assert.equal((await post(base, '/api/ambiences/generate', input)).data.errorCode, 'errorAmbienceValidation');
    assert.equal(calls, 0);
    validated = true;
    const track = (await post(base, '/api/ambiences/generate', input)).data;
    const failed = (await post(base, '/api/tracks/' + track.id + '/refresh')).data;
    assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'errorAmbienceAuth');
    await post(base, '/api/tracks/' + track.id + '/refresh'); assert.equal(calls, 1);
  } finally { if (studio) await close(studio); await close(ace); rmSync(directory, { recursive: true, force: true }); }
});
