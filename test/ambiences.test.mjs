import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createStudio, ambienceInput } from '../server.mjs';
import { createAmbienceEngine } from '../ambience-engine.mjs';
import { ffmpegAvailable, audioDuration } from '../audio-mix.mjs';

const input = { title: 'Hazy room', mode: 'music', prompt: 'Ethereal drone, no drums or vocals.', duration: 5, seed: 42, randomSeed: false, background: { type: 'pink', levelDb: -32 } };
const aceInput = { prompt: 'Jungle', title: 'ACE', duration: 60, bpm: 170, seed: 42, randomSeed: false, thinking: false, format: 'wav' };
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
const close = async server => { if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
const remove = dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const post = async (base, path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const get = async (base, path) => (await fetch(base + path)).json();
async function until(read, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for generation state');
}
function silentWave() {
  const wave = Buffer.alloc(44 + 5 * 8000 * 2);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  return wave;
}

test('ambiences enforce Small modes, duration limits and independent noise before launching Python', () => {
  for (const patch of [{ mode: 'medium' }, { mode: '' }, { duration: 4 }, { duration: 121 }, { duration: 5.5 }, { duration: '60' }, { seed: -1 }, { seed: '42' }, { randomSeed: 'false' }, { prompt: ' ' }, { prompt: 'a'.repeat(6001) }, { background: { type: 'invalid' } }, { background: { levelDb: -11 } }, { ending: { seconds: 6 } }]) {
    assert.throws(() => ambienceInput({ ...input, ...patch }));
  }
  assert.equal(ambienceInput({ ...input, model: 'medium' }).model, 'small-music');
  assert.equal(ambienceInput({ ...input, mode: 'sfx' }).model, 'small-sfx');
  assert.equal(ambienceInput(input).bpm, undefined);
  assert.equal(ambienceInput(input).format, 'wav');
  assert.equal(ambienceInput(input).prompt, input.prompt);
  assert.ok(Number.isInteger(ambienceInput({ ...input, randomSeed: true }).seed));
});

test('local runtime errors are actionable and require no ACE-Step connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterboot-ambience-offline-'));
  const missing = createAmbienceEngine({ python: join(dir, 'missing-python') });
  assert.equal((await missing.health()).available, false);
  await assert.rejects(missing.generate(input, join(dir, 'out.wav')), { code: 'errorAmbienceMissing' });
  let launches = 0;
  const engine = { health: async () => ({ available: false }), generate: async () => { launches++; }, close() {} };
  const studio = createStudio({ dataDir: dir, ambienceEngine: engine, canMix: true });
  try {
    const base = await listen(studio);
    assert.equal((await get(base, '/api/ambiences/health')).available, false);
    assert.equal((await post(base, '/api/ambiences/generate', input)).data.errorCode, 'errorAmbienceMissing');
    assert.equal(launches, 0);
    assert.deepEqual(await get(base, '/api/tracks'), []);
  } finally { await close(studio); await remove(dir); }
});

test('Small generation shares the library, blocks other engines and adds real FFmpeg noise to a separate copy', { skip: !ffmpegAvailable() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterboot-ambience-'));
  const source = silentWave();
  let launches = 0, complete, received, progress;
  const engine = {
    health: async () => ({ available: true }), close() {},
    generate(value, output, onProgress) {
      launches++; received = value; progress = onProgress;
      return new Promise(resolve => { complete = () => { writeFileSync(output, source); resolve({ seed: value.seed, sampleRate: 8000 }); }; });
    },
  };
  let studio = createStudio({ dataDir: dir, ambienceEngine: engine });
  try {
    let base = await listen(studio);
    const created = await post(base, '/api/ambiences/generate', input);
    assert.equal(created.status, 202);
    assert.equal(received.model, 'small-music'); assert.equal(received.prompt, input.prompt); assert.equal(received.seed, 42);
    assert.equal(created.data.audioFile, undefined);
    const refresh = () => post(base, '/api/tracks/' + created.data.id + '/refresh', {}).then(result => result.data);
    assert.equal((await refresh()).status, 'pending');
    progress('generating'); assert.equal((await refresh()).phase, 'generating');
    assert.equal((await post(base, '/api/ambiences/generate', { ...input, mode: 'sfx' })).status, 409);
    assert.equal((await post(base, '/api/generate', aceInput)).status, 409);
    assert.equal((await post(base, '/api/sessions', { mode: 'tracks', minutes: 1, segmentSeconds: 20, input: aceInput })).status, 409);
    complete();
    const ready = await until(refresh, value => value.status === 'ready');
    assert.equal(ready.returnedSeed, 42); assert.equal(ready.generationPrompt, input.prompt);
    assert.deepEqual(ready.texture.background, input.background);
    assert.equal(ready.audioFormat, 'wav'); assert.equal(ready.phase, undefined);
    assert.equal(launches, 1);
    const original = Buffer.from(await (await fetch(base + ready.originalAudioURL)).arrayBuffer());
    const processed = Buffer.from(await (await fetch(base + ready.audioURL)).arrayBuffer());
    assert.deepEqual(original, source); assert.notDeepEqual(processed, source);
    assert.ok(Math.abs(await audioDuration(join(dir, 'audio', ready.id + '-background.wav')) - 5) < 0.1);
    const metadata = await get(base, '/api/tracks/' + ready.id + '/metadata');
    assert.equal(metadata.input.engine, 'stable-audio-3');
    await close(studio);
    studio = createStudio({ dataDir: dir, ambienceEngine: engine }); base = await listen(studio);
    assert.equal((await get(base, '/api/tracks'))[0].status, 'ready');
    assert.equal(launches, 1);
    const sfx = await post(base, '/api/ambiences/generate', { ...input, mode: 'sfx', background: { type: 'off' } });
    assert.equal(sfx.status, 202); assert.equal(received.model, 'small-sfx');
    complete();
    await until(() => post(base, '/api/tracks/' + sfx.data.id + '/refresh', {}).then(result => result.data), value => value.status === 'ready');
    assert.equal(launches, 2);
  } finally { await close(studio); await remove(dir); }
});

test('processing retries use archived audio, while access failures keep prompts and model settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterboot-ambience-retry-'));
  let launches = 0, renders = 0, failRender = true, deny = false;
  const engine = {
    health: async () => ({ available: true }), close() {},
    async generate(value, output) {
      launches++;
      if (deny) throw Object.assign(new Error('Gated model'), { code: 'errorAmbienceAccess' });
      writeFileSync(output, silentWave()); return { seed: value.seed, sampleRate: 8000 };
    },
  };
  const textureRenderer = async (track, texture) => {
    renders++;
    if (failRender) throw new Error('FFmpeg unavailable');
    const file = track.id + '-background.wav'; writeFileSync(join(dir, 'audio', file), silentWave());
    return { processedAudioFile: file, texture };
  };
  const studio = createStudio({ dataDir: dir, ambienceEngine: engine, textureRenderer, canMix: true });
  try {
    const base = await listen(studio);
    const created = await post(base, '/api/ambiences/generate', input);
    await until(() => get(base, '/api/tracks'), values => values[0].errorCode === 'errorBackgroundRender');
    failRender = false;
    const ready = await post(base, '/api/tracks/' + created.data.id + '/refresh', {});
    assert.equal(ready.data.status, 'ready'); assert.equal(launches, 1); assert.equal(renders, 2);
    deny = true;
    const rejected = await post(base, '/api/ambiences/generate', { ...input, mode: 'sfx' });
    const failed = await until(() => get(base, '/api/tracks'), values => values[0].status === 'failed');
    assert.equal(failed[0].id, rejected.data.id); assert.equal(failed[0].errorCode, 'errorAmbienceAccess');
    assert.equal(failed[0].input.prompt, input.prompt); assert.equal(failed[0].input.model, 'small-sfx');
  } finally { await close(studio); await remove(dir); }
});

test('restart marks lost Python jobs interrupted without repeating a generation; missing FFmpeg blocks effects only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterboot-ambience-restart-'));
  mkdirSync(join(dir, 'audio'));
  writeFileSync(join(dir, 'library.json'), JSON.stringify([{ id: 'interrupted', input: ambienceInput(input), status: 'pending' }]));
  let launches = 0;
  const engine = { health: async () => ({ available: true }), close() {}, generate: async (_, output) => { launches++; writeFileSync(output, silentWave()); return { seed: 42 }; } };
  const studio = createStudio({ dataDir: dir, ambienceEngine: engine, canMix: false });
  try {
    const base = await listen(studio);
    const saved = (await get(base, '/api/tracks'))[0];
    assert.equal(saved.status, 'failed'); assert.equal(saved.errorCode, 'errorAmbienceInterrupted');
    assert.equal(launches, 0);
    assert.equal((await post(base, '/api/ambiences/generate', input)).data.errorCode, 'errorFfmpeg');
    assert.equal((await post(base, '/api/ambiences/generate', { ...input, background: { type: 'off' } })).status, 202);
    await until(() => get(base, '/api/tracks'), values => values[0].status === 'ready');
    assert.equal(launches, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'library.json')))[0].status, 'ready');
  } finally { await close(studio); await remove(dir); }
});
