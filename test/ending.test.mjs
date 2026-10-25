import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { renderTexture } from '../audio-effects.mjs';
import { assembleMix, ffmpegAvailable } from '../audio-mix.mjs';
import { endingSettings, musicalEndingPrompt } from '../public/ending.js';
import { sessionPlan } from '../public/session-plan.js';
import { createTrackSettings, needsTexture } from '../session-settings.mjs';
import { createSessionManager } from '../session-manager.mjs';
import { createStudio, generationInput } from '../server.mjs';

const input = { title: 'Natural ending', prompt: 'Instrumental ambient pads', duration: 10, bpm: 100, randomSeed: false, seed: 42, thinking: true, format: 'wav' };

function tone(seconds) {
  const wave = Buffer.alloc(44 + seconds * 8000 * 2);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  for (let i = 0; i < seconds * 8000; i++) wave.writeInt16LE(Math.round(Math.cos(i * Math.PI * 440 / 4000) * 8000), 44 + i * 2);
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
function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 2) sum += (samples.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(sum / (samples.length / 2));
}

test('ending controls reject invalid input and leave older clients unchanged', () => {
  assert.deepEqual(endingSettings(), { seconds: 0 });
  for (const ending of [null, [], { seconds: -1 }, { seconds: 16 }, { seconds: '6' }, { seconds: 0.5 }]) {
    assert.throws(() => endingSettings(ending), { code: 'errorEndingOptions' });
    assert.throws(() => generationInput({ ...input, ending }), { code: 'errorEndingOptions' });
    assert.throws(() => sessionPlan({ minutes: 1, mode: 'tracks', segmentSeconds: 30, ending }), { code: 'errorEndingOptions' });
  }
  assert.equal(musicalEndingPrompt(input.prompt, undefined, 60), input.prompt);
  assert.ok(musicalEndingPrompt(input.prompt, { seconds: 6 }, 10).includes('final 5 seconds'));
  const plan = sessionPlan({ minutes: 1, mode: 'tracks', segmentSeconds: 30, ending: { seconds: 6 }, texture: { chance: 0 } });
  assert.equal(needsTexture(plan), true);
  assert.ok(createTrackSettings(input, plan).every(settings => settings.texture.ending.seconds === 6));
});

test('an abruptly cut track and its background finish at silence without shortening the file', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-ending-')); mkdirSync(join(dataDir, 'audio'));
  try {
    const original = tone(10); writeFileSync(join(dataDir, 'audio', 'source.wav'), original);
    const track = { id: 'ending', audioFile: 'source.wav', input: { duration: 10 } };
    const texture = { grain: 'off', events: [], noiseSeed: 42, background: { type: 'white', levelDb: -24 }, ending: { seconds: 3 } };
    const result = await renderTexture(track, texture, dataDir);
    const samples = pcm(join(dataDir, 'audio', result.processedAudioFile || track.audioFile));
    assert.equal(samples.length, 10 * 44100 * 4);
    assert.ok(rms(samples.subarray(0, 44100 * 4)) > 0.1);
    assert.ok(rms(samples.subarray(-4410 * 4)) < 0.001, 'The final 100 ms must be near silence, including the noise bed');
    assert.equal(samples.readInt16LE(samples.length - 2), 0);
    assert.deepEqual(readFileSync(join(dataDir, 'audio', 'source.wav')), original);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('a mix fades only at its final end, preserving audible crossfades and target duration', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-mix-ending-')); mkdirSync(join(dataDir, 'audio'));
  try {
    writeFileSync(join(dataDir, 'audio', 'source.wav'), tone(10));
    const plan = { durations: [10, 10], crossfadeSeconds: 2, targetSeconds: 18, ending: { seconds: 3 }, background: { type: 'brown', levelDb: -28 } };
    const result = await assembleMix({ id: 'finished', input: { seed: 42 }, plan }, [{ audioFile: 'source.wav' }, { audioFile: 'source.wav' }], dataDir);
    const samples = pcm(join(dataDir, 'audio', result.audioFile));
    assert.ok(Math.abs(result.duration - 18) < 0.01);
    assert.ok(rms(samples.subarray(9 * 44100 * 4, 10 * 44100 * 4)) > 0.1, 'The internal transition must not fade to silence');
    assert.ok(rms(samples.subarray(-4410 * 4)) < 0.001, 'The final mix must fade to silence');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('ending uses the actual file duration and clamps long fades on short excerpts', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-short-ending-')); mkdirSync(join(dataDir, 'audio'));
  try {
    writeFileSync(join(dataDir, 'audio', 'source.wav'), tone(6));
    const result = await renderTexture({ id: 'short', audioFile: 'source.wav', input: { duration: 10 } }, { grain: 'off', events: [], noiseSeed: 42, ending: { seconds: 6 } }, dataDir);
    const samples = pcm(join(dataDir, 'audio', result.processedAudioFile));
    assert.equal(samples.length, 6 * 44100 * 4);
    assert.ok(rms(samples.subarray(0, 2 * 44100 * 4)) > 0.1);
    assert.ok(rms(samples.subarray(-4410 * 4)) < 0.001);
    assert.equal(result.endingAppliedSeconds, 3);
    assert.equal(result.texture.ending.seconds, 6);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('mix sessions request an outro only on the last track, without fading intermediate tracks', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-outro-plan-')), tracks = [], submitted = [];
  let manager;
  try {
    manager = createSessionManager({
      dataDir, canMix: true, pollMs: 5, listTracks: () => tracks,
      async submitTrack(value, extra) { submitted.push(value); const track = { id: 'track-' + tracks.length, status: 'ready', ...extra }; tracks.push(track); return track; },
      async syncTrack() {},
      async processTrack() { assert.fail('Intermediate mix sources must not be faded to silence'); },
      async assemble(session) { assert.equal(session.plan.ending.seconds, 6); return { audioFile: 'mix.wav', duration: 60 }; },
    });
    const plan = sessionPlan({ minutes: 1, mode: 'mix', segmentSeconds: 20, ending: { seconds: 6 } });
    const session = manager.start(input, plan);
    for (let i = 0; i < 200 && manager.get(session.id).status !== 'complete'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(manager.get(session.id).status, 'complete');
    assert.equal(submitted.length, plan.durations.length);
    assert.ok(submitted.slice(0, -1).every(track => track.ending.seconds === 0));
    assert.equal(submitted.at(-1).ending.seconds, 6);
  } finally { manager?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('HTTP finishing repairs existing processed tracks, keeps originals, and retries new endings without regeneration', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-finish-api-')), jobs = [], renderInputs = [];
  let polls = 0, downloads = 0, studio, failEnding = true;
  const engine = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.startsWith('/v1/audio')) { downloads++; res.end(tone(10)); return; }
    let data;
    if (req.url === '/release_task') { jobs.push(body); data = { task_id: 'job-' + jobs.length }; }
    if (req.url === '/query_result') { polls++; data = body.task_id_list.map(task_id => ({ task_id, status: 1, result: [{ file: '/v1/audio?path=source.wav' }] })); }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data }));
  });
  const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
  const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const engineURL = await listen(engine);
    studio = createStudio({ dataDir, engineURL, canMix: false });
    let base = await listen(studio);
    assert.equal((await (await post(base, '/api/generate', { ...input, ending: { seconds: 6 } })).json()).errorCode, 'errorFfmpeg');
    assert.equal(jobs.length, 0);
    await close(studio);
    studio = createStudio({ dataDir, engineURL, canMix: true, async textureRenderer(track, texture) {
      renderInputs.push({ source: track.audioFile, texture });
      if (track.input.ending?.seconds && failEnding) { failEnding = false; throw new Error('fixture failure'); }
      const processedAudioFile = track.id + (texture.ending?.seconds ? '-finished.wav' : '-background.wav');
      writeFileSync(join(dataDir, 'audio', processedAudioFile), tone(10));
      return { processedAudioFile, texture, processedDuration: 10 };
    } });
    base = await listen(studio);
    const background = { type: 'pink', levelDb: -32 };
    const oldTrack = await (await post(base, '/api/generate', { ...input, background })).json();
    const oldPath = '/api/tracks/' + oldTrack.id;
    await post(base, oldPath + '/refresh', {});
    const finished = await (await post(base, oldPath + '/finish', { seconds: 6 })).json();
    assert.ok(renderInputs.at(-1).source.endsWith('-background.wav'), 'Finishing must preserve the previous processed audio');
    assert.deepEqual(finished.texture.background, background);
    assert.equal(finished.texture.ending.seconds, 6);
    assert.ok(finished.audioURL.endsWith('?version=finished'));
    assert.deepEqual(Buffer.from(await (await fetch(base + finished.originalAudioURL)).arrayBuffer()), tone(10));
    await post(base, oldPath + '/finish', { seconds: 6 });
    assert.equal(renderInputs.length, 2, 'Repeated requests must not apply the fade twice');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].prompt, input.prompt);
    const created = await (await post(base, '/api/generate', { ...input, ending: { seconds: 3 } })).json();
    assert.ok(jobs[1].prompt.startsWith(input.prompt));
    assert.ok(jobs[1].prompt.includes('complete musical outro'));
    assert.equal(created.input.prompt, input.prompt);
    assert.equal(created.generationPrompt, jobs[1].prompt);
    const newPath = '/api/tracks/' + created.id;
    assert.equal((await (await post(base, newPath + '/refresh', {})).json()).errorCode, 'errorEndingRender');
    const ready = await (await post(base, newPath + '/refresh', {})).json();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.texture.ending.seconds, 3);
    assert.deepEqual([jobs.length, polls, downloads], [2, 2, 2]);
  } finally {
    if (studio?.listening) await close(studio);
    await close(engine); rmSync(dataDir, { recursive: true, force: true });
  }
});
