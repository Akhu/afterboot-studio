import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yauzl from 'yauzl';
import { ambienceAlbumSettings, ambienceAlbumPlan, albumLoopOrder } from '../public/ambience-album.js';
import { assembleAlbumLoop } from '../audio-album-loop.mjs';
import { audioDuration } from '../audio-mix.mjs';
import { createStudio } from '../server.mjs';

const settings = { count: 3, minSeconds: 5, maxSeconds: 7, loop: { enabled: true, minutes: 1, crossfadeSeconds: 2 } };
const input = { model: 'small-music', title: 'Brume nocturne', prompt: 'Soft ethereal drones, no drums', duration: 5, randomSeed: false, seed: 42, background: { type: 'pink', levelDb: -40 }, ending: { seconds: 3 } };
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
async function post(base, path, body = {}) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function until(read, check) {
  for (let index = 0; index < 500; index++) {
    const value = await read(); if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
}
function tone(path, seconds, frequency) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`, '-ar', '44100', '-ac', '2', path]);
}
async function zipNames(path) {
  return new Promise((resolve, reject) => yauzl.open(path, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const entries = []; zip.on('error', reject); zip.on('entry', entry => { entries.push(entry.fileName); zip.readEntry(); });
    zip.on('end', () => resolve(entries)); zip.readEntry();
  }));
}

test('album bounds are inclusive, plans are deterministic, and invalid controls are rejected', () => {
  for (const patch of [{ count: 0 }, { count: 101 }, { minSeconds: 4 }, { maxSeconds: 121 }, { minSeconds: 8 }, { count: 1.5 }, { loop: null }, { loop: { enabled: 'true' } }, { loop: { enabled: true, minutes: 241 } }, { loop: { enabled: true, crossfadeSeconds: 3 } }]) {
    assert.throws(() => ambienceAlbumSettings({ ...settings, ...patch }), { code: 'errorAmbienceAlbum' });
  }
  const plan = ambienceAlbumPlan({ ...settings, count: 100 }, 42);
  assert.deepEqual(plan, ambienceAlbumPlan({ ...settings, count: 100 }, 42));
  assert.deepEqual([...new Set(plan.durations)].sort(), [5, 6, 7]);
  assert.deepEqual(ambienceAlbumPlan({ ...settings, count: 1, minSeconds: 120, maxSeconds: 120 }, 0).durations, [120]);
});

test('two-hour order covers every track on each pass, changes between loops and never repeats a boundary track', () => {
  const durations = Array.from({ length: 15 }, (_, index) => 60 + index * 4);
  const { order, cycles } = albumLoopOrder(durations, 7200, 2, 42);
  for (const cycle of cycles) assert.deepEqual([...cycle].sort((a, b) => a - b), durations.map((_, index) => index));
  for (let index = 1; index < cycles.length; index++) assert.notDeepEqual(cycles[index], cycles[index - 1]);
  for (let index = 1; index < order.length; index++) assert.notEqual(order[index], order[index - 1]);
  const duration = order.reduce((sum, index, position) => sum + durations[index] - (position ? 2 : 0), 0);
  assert.ok(duration >= 7200 && duration - durations[order.at(-1)] + 2 < 7200);
  for (const durations of [[5], [5, 6]]) assert.ok(albumLoopOrder(durations, 60, 2, 42).order.length > durations.length);
});

test('real FFmpeg loop streams to the exact target with continuous transitions, final fade and unchanged originals', async () => {
  const directory = mkdtempSync(join(tmpdir(), "afterboot-loop-'")); mkdirSync(join(directory, 'audio'));
  const tracks = [5, 6, 7].map((duration, index) => {
    const audioFile = index + '.wav'; tone(join(directory, 'audio', audioFile), duration, 180 + index * 70);
    return { audioFile, input: { duration } };
  });
  const originals = tracks.map(track => readFileSync(join(directory, 'audio', track.audioFile)));
  try {
    for (const fade of [0, 2]) {
      const plan = { ...ambienceAlbumPlan({ ...settings, loop: { ...settings.loop, crossfadeSeconds: fade } }, 42), background: input.background, ending: input.ending };
      plan.durations = tracks.map(track => track.input.duration);
      Object.assign(plan.loop, albumLoopOrder(plan.durations, 60, fade, 42));
      const result = await assembleAlbumLoop({ id: 'test-' + fade, input, plan }, tracks, directory);
      const path = join(directory, 'audio', result.audioFile);
      assert.equal(await audioDuration(path), 60);
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-'], { maxBuffer: 12 * 1024 * 1024 });
      const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
      const rms = (start, end) => Math.sqrt(samples.subarray(start, end).reduce((sum, value) => sum + value * value, 0) / (end - start));
      for (let second = 1; second < 56; second++) assert.ok(rms(second * 44100, (second + 0.2) * 44100) > 0.005, 'No silent gaps across transitions');
      assert.ok(rms(samples.length - 441, samples.length) < 0.0001, 'Final fade reaches silence');
    }
    tracks.forEach((track, index) => assert.deepEqual(readFileSync(join(directory, 'audio', track.audioFile)), originals[index]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('simulated album models + real FFmpeg and ZIP: sequential takes, pause/restart, stable numbering and assembly retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterboot-album-http-'));
  let release, running = 0, maxRunning = 0, calls = 0, failAssembly = true, studio;
  const gate = new Promise(resolve => { release = resolve; });
  const ace = createServer((req, res) => res.end(JSON.stringify({ queue_size: 0, jobs: { running: 0, queued: 0 } })));
  try {
    const engineURL = await listen(ace);
    const options = { dataDir: directory, engineURL, sessionPollMs: 10, getAmbienceStatus: () => ({ installed: true, validated: true }), ambienceRenderer: async track => {
      calls++; running++; maxRunning = Math.max(maxRunning, running);
      if (calls === 1) await gate;
      const audioFile = track.id + '.wav'; tone(join(directory, 'audio', audioFile), track.input.duration, 220); running--;
      return { audioFile, returnedSeed: track.input.seed };
    }, albumLoopRenderer: async (...args) => {
      if (failAssembly) throw Object.assign(new Error('test failure'), { code: 'errorAlbumLoop' });
      return assembleAlbumLoop(...args);
    } };
    studio = createStudio(options); let base = await listen(studio);
    const start = await post(base, '/api/ambiences/albums', { input, album: settings });
    assert.equal(start.status, 202); const id = start.data.id, plan = start.data.plan;
    await until(async () => calls, count => count === 1);
    assert.equal((await post(base, '/api/ambiences/generate', input)).status, 409);
    assert.equal((await post(base, '/api/ambiences/albums', { input, album: settings })).status, 409);
    await post(base, '/api/sessions/' + id + '/pause'); release();
    const session = async () => (await (await fetch(base + '/api/sessions')).json()).sessions[0];
    await until(session, value => value.status === 'paused' && value.completedCount === 1);
    await close(studio); studio = createStudio(options); base = await listen(studio);
    assert.deepEqual((await session()).plan, plan);
    await post(base, '/api/sessions/' + id + '/resume');
    await until(session, value => value.status === 'paused' && value.errorCode === 'errorAlbumLoop');
    assert.equal(calls, 3); failAssembly = false;
    await post(base, '/api/sessions/' + id + '/resume');
    const done = await until(session, value => value.status === 'complete');
    assert.equal(calls, 3); assert.equal(maxRunning, 1); assert.equal(done.duration, 60);
    const metadata = await (await fetch(base + '/api/sessions/' + id + '/metadata')).json();
    const selected = metadata.tracks.sort((a, b) => a.sessionIndex - b.sessionIndex);
    assert.deepEqual(selected.map(track => track.input.title), ['Brume nocturne - 01', 'Brume nocturne - 02', 'Brume nocturne - 03']);
    assert.deepEqual(selected.map(track => track.input.seed), [42, 43, 44]);
    assert.deepEqual(selected.map(track => track.input.duration), plan.durations);
    const archive = await post(base, '/api/sessions/' + id + '/mp3'); assert.equal(archive.status, 200);
    const files = await import('node:fs/promises'); const zipPath = join(directory, 'album.zip');
    await files.writeFile(zipPath, Buffer.from(await (await fetch(base + archive.data.downloadURL)).arrayBuffer()));
    assert.deepEqual(await zipNames(zipPath), ['Brume nocturne - 01.mp3', 'Brume nocturne - 02.mp3', 'Brume nocturne - 03.mp3']);
    assert.match((await fetch(base + done.audioURL)).headers.get('content-disposition'), /Brume nocturne-loop.wav/);
  } finally { release(); if (studio) await close(studio); await close(ace); rmSync(directory, { recursive: true, force: true }); }
});
