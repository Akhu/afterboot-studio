import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { backgroundNoise } from '../public/background-noise.js';
import { sessionPlan } from '../public/session-plan.js';
import { createTrackSettings, needsTexture } from '../session-settings.mjs';
import { renderTexture } from '../audio-effects.mjs';
import { assembleMix, ffmpegAvailable } from '../audio-mix.mjs';
import { createStudio, generationInput } from '../server.mjs';

const input = { title: 'Quiet PC', prompt: 'Instrumental ambient pads', duration: 60, bpm: 100, randomSeed: false, seed: 42, thinking: true, format: 'wav' };
const background = { type: 'brown', levelDb: -32 };
const directory = () => mkdtempSync(join(tmpdir(), 'afterboot-background-'));
function silence(seconds) {
  const wave = Buffer.alloc(44 + seconds * 44100 * 4);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(44100, 24); wave.writeUInt32LE(44100 * 4, 28); wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  return wave;
}
function pcm(file) {
  const wave = readFileSync(file);
  for (let offset = 12; offset + 8 <= wave.length;) {
    const size = wave.readUInt32LE(offset + 4);
    if (wave.toString('ascii', offset, offset + 4) === 'data') return wave.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  assert.fail('Missing PCM data');
}
function rms(samples, difference = false) {
  let sum = 0, previous = 0;
  for (let offset = 0; offset < samples.length; offset += 4) {
    const value = samples.readInt16LE(offset) / 32768;
    sum += (difference ? value - previous : value) ** 2; previous = value;
  }
  return Math.sqrt(sum / (samples.length / 4));
}

test('background settings validate before generation and apply independently of vintage probability', () => {
  assert.equal(backgroundNoise().type, 'off');
  for (const value of [null, [], { type: 'red' }, { levelDb: -61 }, { levelDb: -11 }, { levelDb: '-32' }]) {
    assert.throws(() => backgroundNoise(value), { code: 'errorBackgroundOptions' });
    assert.throws(() => generationInput({ ...input, background: value }), { code: 'errorBackgroundOptions' });
    assert.throws(() => sessionPlan({ minutes: 1, mode: 'mix', segmentSeconds: 30, background: value }), { code: 'errorBackgroundOptions' });
  }
  for (const mode of ['tracks', 'mix']) {
    const plan = sessionPlan({ minutes: 1, mode, segmentSeconds: 30, background, texture: { chance: 0 } });
    assert.equal(needsTexture(plan), true);
    const settings = createTrackSettings(input, plan);
    assert.ok(settings.every(item => item.texture.grain === 'off' && !item.texture.events.length));
    assert.ok(settings.every(item => mode === 'tracks' ? item.texture.background.type === 'brown' : !item.texture.background));
  }
});

test('all noise colors render throughout silence; volume changes gain and originals stay intact', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = directory(); mkdirSync(join(dataDir, 'audio'));
  try {
    const original = silence(6); writeFileSync(join(dataDir, 'audio', 'source.wav'), original);
    const render = async (type, levelDb) => {
      const track = { id: type + Math.abs(levelDb), audioFile: 'source.wav', input: { duration: 6 } };
      const result = await renderTexture(track, { grain: 'off', events: [], noiseSeed: 42, background: { type, levelDb } }, dataDir);
      const samples = pcm(join(dataDir, 'audio', result.processedAudioFile));
      assert.equal(samples.length, 6 * 44100 * 4);
      for (let second = 0; second < 6; second++) assert.ok(rms(samples.subarray(second * 44100 * 4, (second + 1) * 44100 * 4)) > 0);
      return samples;
    };
    const brightness = [];
    for (const type of ['white', 'pink', 'brown', 'dark']) {
      const samples = await render(type, -32);
      brightness.push(rms(samples, true) / rms(samples));
    }
    assert.ok(brightness.every((value, i) => !i || value < brightness[i - 1]), 'Colors must progressively attenuate high frequencies');
    const quiet = await render('white', -36), loud = await render('white', -24);
    assert.ok(Math.abs(rms(loud) / rms(quiet) - 10 ** (12 / 20)) < 0.02);
    assert.deepEqual(readFileSync(join(dataDir, 'audio', 'source.wav')), original);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('mix noise is one continuous stream across every crossfade and matches a single render', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = directory(); mkdirSync(join(dataDir, 'audio'));
  try {
    const plan = sessionPlan({ minutes: 1, mode: 'mix', segmentSeconds: 20, crossfadeSeconds: 4, background });
    const tracks = plan.durations.map((duration, i) => {
      const audioFile = i + '.wav'; writeFileSync(join(dataDir, 'audio', audioFile), silence(duration)); return { audioFile };
    });
    const result = await assembleMix({ id: 'continuous', input, plan }, tracks, dataDir);
    writeFileSync(join(dataDir, 'audio', 'reference.wav'), silence(60));
    const reference = await renderTexture({ id: 'reference', audioFile: 'reference.wav', input }, { grain: 'off', events: [], noiseSeed: input.seed, background }, dataDir);
    assert.ok(Math.abs(result.duration - 60) < 0.01);
    assert.deepEqual(pcm(join(dataDir, 'audio', result.audioFile)), pcm(join(dataDir, 'audio', reference.processedAudioFile)));
    const withSkip = await renderTexture({ id: 'skip', audioFile: 'reference.wav', input }, { grain: 'off', events: [{ start: 88200, size: 4410, repeats: 4 }], noiseSeed: input.seed, background }, dataDir);
    assert.deepEqual(pcm(join(dataDir, 'audio', withSkip.processedAudioFile)), pcm(join(dataDir, 'audio', reference.processedAudioFile)), 'CD skips must not repeat or interrupt the noise bed');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('single-track noise retries archived audio after restart and keeps original downloads', async () => {
  const dataDir = directory();
  let submissions = 0, polls = 0, downloads = 0, renders = 0, studio;
  const engine = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.startsWith('/v1/audio')) { downloads++; res.end('original-mp3'); return; }
    let data;
    if (req.url === '/release_task') { submissions++; assert.equal(body.background, undefined); data = { task_id: 'job-1' }; }
    if (req.url === '/query_result') { polls++; data = [{ task_id: 'job-1', status: 1, result: [{ file: '/v1/audio?path=source.mp3' }] }]; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data }));
  });
  const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
  const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const engineURL = await listen(engine);
    const options = { dataDir, engineURL, canMix: true, async textureRenderer(track, texture) {
      renders++;
      if (renders === 1) throw new Error('fixture: failed processing');
      const processedAudioFile = track.id + '-background.wav'; writeFileSync(join(dataDir, 'audio', processedAudioFile), 'processed-wav');
      return { processedAudioFile, texture };
    } };
    studio = createStudio({ ...options, canMix: false });
    let base = await listen(studio);
    for (const request of [
      ['/api/generate', { ...input, background }],
      ['/api/sessions', { input, minutes: 1, mode: 'tracks', segmentSeconds: 30, background }],
    ]) assert.equal((await (await post(base, ...request)).json()).errorCode, 'errorFfmpeg');
    assert.equal(submissions, 0);
    await close(studio); studio = createStudio(options); base = await listen(studio);
    const created = await (await post(base, '/api/generate', { ...input, format: 'mp3', background })).json();
    const path = '/api/tracks/' + created.id;
    assert.equal((await (await post(base, path + '/refresh', {})).json()).errorCode, 'errorBackgroundRender');
    await close(studio); studio = createStudio(options); base = await listen(studio);
    const ready = await (await post(base, path + '/refresh', {})).json();
    assert.equal(ready.status, 'ready'); assert.equal(ready.audioFormat, 'wav');
    assert.equal(await (await fetch(base + ready.audioURL)).text(), 'processed-wav');
    assert.equal(await (await fetch(base + ready.originalAudioURL)).text(), 'original-mp3');
    const metadata = await (await fetch(base + path + '/metadata')).json();
    assert.deepEqual(metadata.texture.background, background);
    assert.deepEqual([submissions, polls, downloads, renders], [1, 1, 1, 2]);
  } finally {
    if (studio?.listening) await close(studio);
    await close(engine); rmSync(dataDir, { recursive: true, force: true });
  }
});
