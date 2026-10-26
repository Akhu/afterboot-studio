import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionPlan } from '../public/session-plan.js';
import { createTrackSettings, trackPrompt } from '../session-settings.mjs';
import { createSessionManager } from '../session-manager.mjs';
import { renderTexture } from '../audio-effects.mjs';
import { ffmpegAvailable, assembleMix } from '../audio-mix.mjs';
import { createStudio } from '../server.mjs';

const input = { title: 'Tempo session', prompt: 'Atmospheric jungle, 170 BPM. No vocals.', bpm: 170, duration: 20, seed: 42, randomSeed: false, thinking: true, format: 'mp3' };
const options = { mode: 'tracks', minutes: 1, segmentSeconds: 20, tempo: { enabled: true, min: 150, max: 200 }, texture: { grain: 'light', cdSkips: true, chance: 100 } };
const directory = () => mkdtempSync(join(tmpdir(), 'afterboot-texture-'));
async function until(predicate) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Session did not reach expected state');
}
test('BPM range bounds are inclusive; prompt tempos match and style text is kept', () => {
  const plan = sessionPlan(options);
  const low = createTrackSettings(input, plan, min => min);
  assert.ok(low.every(item => item.bpm === 150));
  const high = createTrackSettings(input, plan, (min, max) => max - 1);
  assert.ok(high.every(item => item.bpm === 200));
  assert.equal(trackPrompt(input.prompt, 200, true), 'Atmospheric jungle, 200 BPM. No vocals.');
  assert.equal(trackPrompt('Ambient, 150-180 bpm.', 175, true), 'Ambient, 175 BPM.');
  assert.equal(trackPrompt('Ambient', 150, true), 'Ambient\nTarget tempo: 150 BPM.');
  assert.equal(trackPrompt(input.prompt, 200, false), input.prompt);
  const dry = createTrackSettings(input, sessionPlan({ ...options, texture: { ...options.texture, chance: 0 } }));
  assert.ok(dry.every(item => item.texture.grain === 'off' && !item.texture.events.length));
});
test('invalid ranges and texture controls are refused before engine submission', () => {
  for (const tempo of [{ enabled: true, min: 201, max: 150 }, { enabled: true, min: 29, max: 170 }, { enabled: true, min: 150, max: 301 }, { enabled: 'yes' }]) {
    assert.throws(() => sessionPlan({ ...options, tempo }));
  }
  for (const texture of [{ grain: 'unknown' }, { cdSkips: 'yes' }, { chance: -1 }, { chance: 101 }, null]) {
    assert.throws(() => sessionPlan({ ...options, texture }));
  }
});
test('BPM and effect choices survive restart, and a failed effect retries the saved original', async () => {
  const dataDir = directory(), tracks = [], submitted = [];
  let manager, processCalls = 0;
  const dependencies = {
    dataDir, canMix: true, pollMs: 5, listTracks: () => tracks,
    async submitTrack(value, extra) {
      submitted.push(value);
      const track = { id: 'track-' + submitted.length, status: 'pending', input: value, ...extra };
      tracks.push(track); return track;
    },
    async syncTrack(track) { track.status = 'ready'; },
    async processTrack(track, texture) {
      processCalls++;
      if (processCalls === 1) throw Object.assign(new Error('processing unavailable'), { code: 'errorTextureRender' });
      track.processedAudioFile = track.id + '-vintage.wav'; track.texture = texture;
    },
  };
  try {
    manager = createSessionManager(dependencies);
    const created = manager.start(input, sessionPlan(options));
    const planned = structuredClone(manager.get(created.id).trackSettings);
    await until(() => manager.get(created.id).status === 'paused');
    assert.equal(submitted.length, 1);
    assert.equal(manager.get(created.id).errorCode, 'errorTextureRender');
    manager.close(); manager = createSessionManager(dependencies);
    assert.deepEqual(manager.get(created.id).trackSettings, planned);
    manager.control(created.id, 'resume');
    await until(() => manager.get(created.id).status === 'complete');
    assert.equal(submitted.length, 3);
    assert.deepEqual(submitted.map(item => item.bpm), planned.map(item => item.bpm));
    assert.ok(submitted.every(item => item.prompt.includes(item.bpm + ' BPM')));
    assert.ok(tracks.every((track, index) => track.texture.noiseSeed === planned[index].texture.noiseSeed));
  } finally { manager?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
function wav(seconds, silent = false) {
  const samples = seconds * 44100, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(44100, 24); data.writeUInt32LE(88200, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  if (!silent) for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * 0.01 + i * i * 0.0000001) * 6000), 44 + i * 2);
  return data;
}
function pcm(wave) {
  let offset = 12;
  while (offset + 8 <= wave.length) {
    const size = wave.readUInt32LE(offset + 4);
    if (wave.toString('ascii', offset, offset + 4) === 'data') return wave.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  assert.fail('No PCM data');
}
test('CD skips repeat the selected samples without changing duration or the original', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = directory(); mkdirSync(join(dataDir, 'audio'));
  try {
    const original = wav(6), source = join(dataDir, 'audio', 'source.wav'); writeFileSync(source, original);
    const event = { start: 88200, size: 4410, repeats: 4 };
    const result = await renderTexture({ id: 'skips', audioFile: 'source.wav', input: { duration: 6 } }, { grain: 'off', noiseSeed: 42, events: [event] }, dataDir);
    const audio = pcm(readFileSync(join(dataDir, 'audio', result.processedAudioFile)));
    assert.equal(audio.length, 6 * 44100 * 4);
    const fragment = audio.subarray(event.start * 4, (event.start + event.size) * 4);
    // Float-to-PCM conversion can differ by a quantization step between frames.
    for (let i = 1; i < event.repeats; i++) {
      const repeated = audio.subarray((event.start + i * event.size) * 4, (event.start + (i + 1) * event.size) * 4);
      for (let sample = 0; sample < fragment.length; sample += 2) assert.ok(Math.abs(repeated.readInt16LE(sample) - fragment.readInt16LE(sample)) <= 2);
    }
    assert.deepEqual(readFileSync(source), original);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
test('grain produces low-level seeded noise, preserves duration and never overwrites clean audio', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = directory(); mkdirSync(join(dataDir, 'audio'));
  try {
    const original = wav(6, true); writeFileSync(join(dataDir, 'audio', 'source.wav'), original);
    const texture = { grain: 'light', noiseSeed: 424242, events: [] };
    const track = { id: 'grain1', audioFile: 'source.wav', input: { duration: 6 } };
    const first = await renderTexture(track, texture, dataDir);
    const second = await renderTexture({ ...track, id: 'grain2' }, texture, dataDir);
    const a = pcm(readFileSync(join(dataDir, 'audio', first.processedAudioFile)));
    const b = pcm(readFileSync(join(dataDir, 'audio', second.processedAudioFile)));
    assert.equal(a.length, 6 * 44100 * 4);
    assert.deepEqual(a, b);
    let squares = 0;
    for (let offset = 0; offset < a.length; offset += 2) squares += (a.readInt16LE(offset) / 32768) ** 2;
    const rms = Math.sqrt(squares / (a.length / 2));
    assert.ok(rms > 0 && rms < 0.01, 'Hiss must be present but quiet');
    assert.deepEqual(readFileSync(join(dataDir, 'audio', 'source.wav')), original);
    writeFileSync(join(dataDir, 'audio', 'unreadable-original.mp3'), 'fixture: processed copy must be selected');
    const mixed = await assembleMix({ id: 'processed-mix', plan: { durations: [6, 6], crossfadeSeconds: 1, targetSeconds: 11 } }, [
      { audioFile: 'unreadable-original.mp3', processedAudioFile: first.processedAudioFile }, { audioFile: 'source.wav' },
    ], dataDir);
    assert.ok(Math.abs(mixed.duration - 11) < 0.01);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
test('HTTP audio serves separate vintage and original files with correct formats and saved BPM', async () => {
  const dataDir = directory(), jobs = [];
  const original = Buffer.from('original-mp3-fixture'), processed = Buffer.from('processed-wav-fixture');
  const engine = createServer(async (req, res) => {
    if (req.url === '/v1/model_inventory') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: { models: [{ name: 'acestep-v15-turbo', is_loaded: true }] } })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.startsWith('/v1/audio')) { res.end(original); return; }
    let data;
    if (req.url === '/release_task') { jobs.push(body); data = { task_id: 'job-' + jobs.length }; }
    if (req.url === '/query_result') data = body.task_id_list.map(task_id => ({ task_id, status: 1, result: JSON.stringify([{ file: '/v1/audio?path=fixture.mp3' }]) }));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data }));
  });
  let studio;
  try {
    engine.listen(0, '127.0.0.1'); await once(engine, 'listening');
    studio = createStudio({
      dataDir, canMix: true, sessionPollMs: 5, engineURL: 'http://127.0.0.1:' + engine.address().port,
      async textureRenderer(track, texture) {
        const processedAudioFile = track.id + '-vintage.wav';
        writeFileSync(join(dataDir, 'audio', processedAudioFile), processed); return { processedAudioFile, texture };
      },
    });
    studio.listen(0, '127.0.0.1'); await once(studio, 'listening');
    const base = 'http://127.0.0.1:' + studio.address().port;
    const response = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...options, input }) });
    assert.equal(response.status, 202);
    await until(() => JSON.parse(readFileSync(join(dataDir, 'sessions.json')))[0].status === 'complete');
    const tracks = await (await fetch(base + '/api/tracks')).json(), track = tracks[0];
    assert.equal(track.audioFormat, 'wav');
    assert.ok(track.audioURL.includes('?version=vintage'));
    const vintage = await fetch(base + track.audioURL + '&download');
    assert.equal(vintage.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await vintage.arrayBuffer()), processed);
    const clean = await fetch(base + track.originalAudioURL + '&download');
    assert.equal(clean.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await clean.arrayBuffer()), original);
    assert.ok(jobs.every(job => job.bpm >= 150 && job.bpm <= 200 && job.prompt.includes(job.bpm + ' BPM')));
    const metadata = await (await fetch(base + '/api/tracks/' + track.id + '/metadata')).json();
    assert.equal(metadata.texture.grain, 'light');
    assert.equal(metadata.audioFile, undefined); assert.equal(metadata.processedAudioFile, undefined);
  } finally {
    if (studio?.listening) { studio.closeAllConnections(); await new Promise(resolve => studio.close(resolve)); }
    engine.closeAllConnections(); await new Promise(resolve => engine.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
