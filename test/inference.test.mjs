import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { inferenceSettings, stableArrangement } from '../public/inference-settings.js';
import { masteringSettings } from '../public/mastering.js';
import { sessionPlan } from '../public/session-plan.js';
import { createTrackSettings, needsTexture } from '../session-settings.mjs';
import { createSessionManager } from '../session-manager.mjs';
import { createStudio, generationInput } from '../server.mjs';
import { renderTexture } from '../audio-effects.mjs';
import { audioDuration, assembleMix, ffmpegAvailable } from '../audio-mix.mjs';
import { measureLoudness } from '../audio-mastering.mjs';

const input = { title: 'Stable night', prompt: 'Instrumental atmospheric jungle, 170 BPM', duration: 10, bpm: 170, randomSeed: false, seed: 42, thinking: true, format: 'wav' };
const mastering = { enabled: true, targetLufs: -18, compression: true };
const inference = { temperature: 0.7, topP: 0.92, topK: 40, arrangement: stableArrangement };
const clean = { grain: 'off', events: [], noiseSeed: 42 };
const remove = directory => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
const post = async (base, path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
function tone(amplitude, seconds = 10) {
  const wave = Buffer.alloc(44 + seconds * 8000 * 2);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  for (let i = 0; i < seconds * 8000; i++) wave.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 / 4000) * (typeof amplitude === 'function' ? amplitude(i / 8000) : amplitude)), 44 + i * 2);
  return wave;
}
function pcm(path) {
  const wave = readFileSync(path);
  for (let offset = 12; offset + 8 <= wave.length;) {
    const size = wave.readUInt32LE(offset + 4);
    if (wave.toString('ascii', offset, offset + 4) === 'data') return wave.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  assert.fail('Missing PCM samples');
}
function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 2) sum += (samples.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(sum / (samples.length / 2));
}
const section = (samples, start, seconds = 1) => samples.subarray(start * 44100 * 4, (start + seconds) * 44100 * 4);

test('inference and mastering reject invalid settings and preserve older clients', () => {
  assert.equal(inferenceSettings().temperature, 0.85);
  assert.equal(masteringSettings().enabled, false);
  for (const value of [null, [], { temperature: '0.7' }, { temperature: -1 }, { temperature: Infinity }, { temperature: 2.01 }, { topP: 0 }, { topP: 1.1 }, { topK: 1.5 }, { topK: 1001 }, { arrangement: 'x'.repeat(1801) }]) {
    assert.throws(() => generationInput({ ...input, inference: value }), { code: 'errorInferenceOptions' });
  }
  for (const value of [null, [], { enabled: 'true' }, { compression: 1 }, { targetLufs: -25 }, { targetLufs: -13 }, { targetLufs: NaN }]) {
    assert.throws(() => masteringSettings(value), { code: 'errorMasteringOptions' });
    assert.throws(() => sessionPlan({ minutes: 1, mode: 'mix', segmentSeconds: 20, mastering: value }), { code: 'errorMasteringOptions' });
  }
  for (const mode of ['tracks', 'mix']) {
    const plan = sessionPlan({ minutes: 1, mode, segmentSeconds: 20, mastering });
    assert.ok(needsTexture(plan));
    assert.ok(createTrackSettings(input, plan).every(settings => settings.texture.mastering.targetLufs === -18));
  }
  assert.equal(needsTexture(sessionPlan({ minutes: 1, mode: 'mix', segmentSeconds: 20 })), false);
});

test('HTTP passes sampling controls only with planning, saves exact prompts and retries mastering after restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-inference-')), jobs = [];
  let downloads = 0, studio, fail = true;
  const engine = createServer(async (req, res) => {
    if (req.url === '/v1/model_inventory') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: { models: [{ name: 'acestep-v15-turbo', is_loaded: true }] } })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.startsWith('/v1/audio')) { downloads++; res.end(tone(4000)); return; }
    const data = req.url === '/release_task' ? (jobs.push(body), { task_id: 'job-' + jobs.length }) : body.task_id_list.map(task_id => ({ task_id, status: 1, result: [{ file: '/v1/audio?path=source.wav' }] }));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data }));
  });
  const textureRenderer = async (track, texture) => {
    if (fail) { fail = false; throw new Error('Temporary processing failure'); }
    const processedAudioFile = track.id + '-mastered.wav';
    writeFileSync(join(dataDir, 'audio', processedAudioFile), tone(8000));
    return { processedAudioFile, texture };
  };
  try {
    const engineURL = await listen(engine);
    studio = createStudio({ dataDir, engineURL, canMix: false });
    let base = await listen(studio);
    assert.equal((await post(base, '/api/generate', { ...input, mastering })).data.errorCode, 'errorFfmpeg');
    assert.equal(jobs.length, 0);
    await close(studio);
    studio = createStudio({ dataDir, engineURL, canMix: true, textureRenderer }); base = await listen(studio);
    const created = await post(base, '/api/generate', { ...input, inference, mastering });
    assert.equal(created.status, 202);
    assert.equal(jobs[0].lm_temperature, 0.7); assert.equal(jobs[0].lm_top_p, 0.92); assert.equal(jobs[0].lm_top_k, 40);
    assert.equal(jobs[0].inference_steps, 8); assert.equal(jobs[0].use_cot_caption, false);
    assert.equal(jobs[0].guidance_scale, undefined);
    assert.ok(jobs[0].prompt.includes(stableArrangement));
    assert.equal(created.data.input.prompt, input.prompt);
    assert.equal(created.data.generationPrompt, jobs[0].prompt);
    const path = '/api/tracks/' + created.data.id + '/refresh';
    assert.equal((await post(base, path, {})).data.errorCode, 'errorMasteringRender');
    await close(studio);
    studio = createStudio({ dataDir, engineURL, canMix: true, textureRenderer }); base = await listen(studio);
    const ready = (await post(base, path, {})).data;
    assert.equal(ready.status, 'ready'); assert.equal(ready.texture.mastering.targetLufs, -18);
    assert.deepEqual(ready.input.inference, inference);
    assert.ok(ready.audioURL.endsWith('?version=mastered'));
    assert.deepEqual(Buffer.from(await (await fetch(base + ready.originalAudioURL)).arrayBuffer()), tone(4000));
    assert.deepEqual([jobs.length, downloads], [1, 1]);
    await post(base, '/api/generate', { ...input, inference, thinking: false });
    assert.equal(jobs[1].lm_temperature, undefined); assert.equal(jobs[1].lm_top_p, undefined); assert.equal(jobs[1].lm_top_k, undefined);
    assert.ok(jobs[1].prompt.includes(stableArrangement), 'Arrangement applies independently of LM planning');
  } finally { if (studio?.listening) await close(studio); await close(engine); await remove(dataDir); }
});

test('a session retries saved mastering before mixing and keeps sampling settings on every track', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-stable-session-')), tracks = [], submissions = [];
  let manager, failures = 1, processed = 0;
  const dependencies = {
    dataDir, canMix: true, pollMs: 5, listTracks: () => tracks,
    async submitTrack(value, extra) { submissions.push(value); const track = { id: 't-' + tracks.length, input: value, status: 'ready', audioFile: 'source.wav', ...extra }; tracks.push(track); return track; },
    async syncTrack() {},
    async processTrack(track, texture) { if (failures > 0) { failures--; throw Object.assign(new Error('Retry'), { code: 'errorMasteringRender' }); } track.processedAudioFile = track.id + '.wav'; track.texture = texture; processed++; },
    async assemble() { assert.ok(tracks.every(track => track.texture.mastering.enabled)); return { audioFile: 'mix.wav', duration: 60 }; },
  };
  const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Session timeout'); };
  try {
    manager = createSessionManager(dependencies);
    const session = manager.start({ ...input, inference, mastering }, sessionPlan({ minutes: 1, mode: 'mix', segmentSeconds: 20, mastering }));
    await until(() => manager.get(session.id).status === 'paused');
    assert.equal(submissions.length, 1);
    manager.close(); manager = createSessionManager(dependencies);
    manager.control(session.id, 'resume');
    await until(() => manager.get(session.id).status === 'complete');
    assert.equal(processed, session.plan.durations.length);
    assert.equal(submissions.length, session.plan.durations.length);
    assert.ok(submissions.every(track => track.inference.temperature === 0.7));
  } finally { manager?.close(); await remove(dataDir); }
});

test('two-pass mastering matches quiet and loud tracks, preserves samples and originals, then mixes them', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-loudness-')); mkdirSync(join(dataDir, 'audio'));
  try {
    const tracks = [];
    for (const [id, amplitude] of [['quiet', 1000], ['loud', 20000]]) {
      const original = tone(amplitude); const audioFile = id + '.wav'; writeFileSync(join(dataDir, 'audio', audioFile), original);
      const track = { id, audioFile, input: { duration: 10 } };
      Object.assign(track, await renderTexture(track, { ...clean, mastering }, dataDir));
      const path = join(dataDir, 'audio', track.processedAudioFile);
      const measurement = await measureLoudness(path, [], '0:a', { ...mastering, compression: false });
      assert.ok(Math.abs(Number(measurement.input_i) + 18) < 0.5, 'Expected about -18 LUFS: ' + measurement.input_i);
      assert.ok(Number(measurement.input_tp) <= -0.9);
      assert.equal(await audioDuration(path), 10);
      assert.deepEqual(readFileSync(join(dataDir, 'audio', audioFile)), original);
      tracks.push(track);
    }
    const plan = { durations: [10, 10], crossfadeSeconds: 2, targetSeconds: 18, mastering };
    const mixed = await assembleMix({ id: 'stable', plan }, tracks, dataDir);
    const samples = pcm(join(dataDir, 'audio', mixed.audioFile));
    assert.equal(samples.length, 18 * 44100 * 4);
    assert.ok(Math.abs(20 * Math.log10(rms(section(samples, 2)) / rms(section(samples, 12)))) < 0.5);
    assert.ok(rms(section(samples, 8)) > 0.05, 'Crossfade must remain audible');
  } finally { await remove(dataDir); }
});

test('gentle compression reduces internal level jumps while noise and ending keep their duration', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-dynamics-')); mkdirSync(join(dataDir, 'audio'));
  try {
    writeFileSync(join(dataDir, 'audio', 'source.wav'), tone(t => t < 5 ? 2000 : 25000));
    const outputs = [];
    for (const compression of [false, true]) {
      const result = await renderTexture({ id: String(compression), audioFile: 'source.wav', input: { duration: 10 } }, { ...clean, mastering: { ...mastering, compression } }, dataDir);
      const samples = pcm(join(dataDir, 'audio', result.processedAudioFile));
      outputs.push(20 * Math.log10(rms(section(samples, 7)) / rms(section(samples, 2))));
    }
    assert.ok(outputs[1] < outputs[0] - 4, 'Compression should reduce the level jump: ' + outputs);
    const finished = await renderTexture({ id: 'finished', audioFile: 'source.wav', input: { duration: 10 } }, { ...clean, mastering, background: { type: 'brown', levelDb: -28 }, ending: { seconds: 3 } }, dataDir);
    const samples = pcm(join(dataDir, 'audio', finished.processedAudioFile));
    assert.equal(samples.length, 10 * 44100 * 4);
    assert.equal(samples.readInt16LE(samples.length - 2), 0);
    assert.ok(rms(samples.subarray(-4410 * 4)) < 0.001);
  } finally { await remove(dataDir); }
});

test('silent source stays silent through normalization instead of producing invalid gains', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-silent-master-')); mkdirSync(join(dataDir, 'audio'));
  try {
    writeFileSync(join(dataDir, 'audio', 'silent.wav'), tone(0));
    const result = await renderTexture({ id: 'silent', audioFile: 'silent.wav', input: { duration: 10 } }, { ...clean, mastering }, dataDir);
    const samples = pcm(join(dataDir, 'audio', result.processedAudioFile));
    assert.equal(samples.length, 10 * 44100 * 4); assert.equal(rms(samples), 0);
  } finally { await remove(dataDir); }
});
