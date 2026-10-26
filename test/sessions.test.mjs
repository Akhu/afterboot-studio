import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { sessionPlan } from '../public/session-plan.js';
import { createSessionManager } from '../session-manager.mjs';
import { assembleMix, ffmpegAvailable } from '../audio-mix.mjs';
import { createStudio } from '../server.mjs';

const input = { title: 'Night drive', prompt: 'Instrumental atmospheric jungle', bpm: 170, duration: 20, randomSeed: false, seed: 900, thinking: true, format: 'wav' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let index = 0; index < 250; index++) { if (predicate()) return; await sleep(10); }
  assert.fail('Timed out waiting for session state');
}
function directory() { return mkdtempSync(join(tmpdir(), 'afterboot-sessions-')); }

test('30/40 minute plans compensate every crossfade and respect the 600-second limit', () => {
  for (const minutes of [30, 40]) for (const segmentSeconds of [60, 180, 300, 600]) for (const mode of ['tracks', 'mix']) {
    const plan = sessionPlan({ minutes, segmentSeconds, mode, crossfadeSeconds: 8 });
    assert.equal(plan.durations.reduce((sum, seconds) => sum + seconds, 0) - (plan.durations.length - 1) * plan.crossfadeSeconds, minutes * 60);
    assert.ok(plan.durations.every(seconds => seconds >= 10 && seconds <= segmentSeconds));
  }
  for (const patch of [{ minutes: 0 }, { minutes: 121 }, { segmentSeconds: 601 }, { segmentSeconds: 10, crossfadeSeconds: 8 }, { mode: 'unknown' }]) {
    assert.throws(() => sessionPlan({ minutes: 30, mode: 'mix', segmentSeconds: 300, ...patch }));
  }
});

test('server queue is sequential, pauses after the current track, resumes after restart and never repeats saved tracks', async () => {
  const dataDir = directory(), tracks = [], submissions = [];
  let finish = false, manager;
  const dependencies = {
    dataDir, listTracks: () => tracks, canMix: false, pollMs: 5,
    async submitTrack(value, extra) {
      assert.ok(!tracks.some(track => track.status === 'pending'));
      const track = { id: 'track-' + submissions.length, input: value, status: 'pending', ...extra };
      submissions.push(value); tracks.push(track); return track;
    },
    async syncTrack(track) { if (finish) track.status = 'ready'; },
  };
  try {
    manager = createSessionManager(dependencies);
    const session = manager.start(input, sessionPlan({ minutes: 1, mode: 'tracks', segmentSeconds: 20 }));
    await until(() => tracks.length === 1);
    assert.throws(() => manager.start(input, session.plan), { code: 'errorSessionBusy' });
    manager.control(session.id, 'pause');
    finish = true;
    await until(() => manager.get(session.id).status === 'paused');
    assert.equal(tracks.length, 1);
    manager.close();
    manager = createSessionManager(dependencies);
    assert.equal(manager.get(session.id).status, 'paused');
    manager.control(session.id, 'resume');
    await until(() => manager.get(session.id).status === 'complete');
    assert.deepEqual(submissions.map(value => value.seed), [900, 901, 902]);
    assert.deepEqual(submissions.map(value => value.duration), [20, 20, 20]);
    assert.equal(manager.list()[0].completedCount, 3);
    assert.equal(manager.busy(), false);
  } finally { manager?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('uncertain submissions cannot retry automatically; failed tracks can retry or stop', async () => {
  const dataDir = directory(), tracks = [];
  let calls = 0;
  const dependencies = {
    dataDir, listTracks: () => tracks, canMix: false, pollMs: 5,
    async submitTrack(value, extra) {
      calls++;
      if (calls === 1) throw Object.assign(new Error('timeout'), { code: 'errorEngineOffline' });
      const track = { id: 'track-' + calls, input: value, status: 'pending', ...extra };
      tracks.push(track); return track;
    },
    async syncTrack(track) { track.status = 'failed'; },
  };
  let manager;
  try {
    manager = createSessionManager(dependencies);
    const session = manager.start(input, sessionPlan({ minutes: 1, mode: 'tracks', segmentSeconds: 60 }));
    await until(() => manager.get(session.id).status === 'paused');
    assert.equal(calls, 1);
    assert.throws(() => manager.control(session.id, 'resume'), { code: 'errorSessionSubmission' });
    manager.close(); manager = createSessionManager(dependencies);
    assert.throws(() => manager.control(session.id, 'resume'), { code: 'errorSessionSubmission' });
    manager.control(session.id, 'stop');
    const retry = manager.start(input, session.plan);
    await until(() => manager.get(retry.id).status === 'paused');
    assert.equal(manager.get(retry.id).errorCode, 'errorSessionTrack');
    manager.control(retry.id, 'resume');
    await until(() => calls === 3 && manager.get(retry.id).status === 'paused');
    manager.control(retry.id, 'stop');
    assert.equal(manager.get(retry.id).status, 'stopped');
    assert.equal(manager.busy(), false);
  } finally { manager?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

function wave(seconds) {
  const samples = seconds * 8000, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) data.writeInt16LE(Math.round(Math.sin(sample * Math.PI * 440 / 8000) * 1000), 44 + sample * 2);
  return data;
}
test('real FFmpeg produces the target length with fades, keeps originals and refuses short engine outputs', { skip: !ffmpegAvailable() }, async () => {
  const dataDir = directory(); mkdirSync(join(dataDir, 'audio'));
  try {
    const plan = sessionPlan({ minutes: 1, mode: 'mix', segmentSeconds: 30, crossfadeSeconds: 4 });
    const tracks = plan.durations.map((duration, index) => {
      const audioFile = index + '.wav'; writeFileSync(join(dataDir, 'audio', audioFile), wave(duration)); return { audioFile };
    });
    const result = await assembleMix({ id: 'test', plan }, tracks, dataDir);
    assert.ok(Math.abs(result.duration - 60) < 0.1);
    assert.ok(existsSync(join(dataDir, 'audio', result.audioFile)));
    assert.ok(tracks.every(track => existsSync(join(dataDir, 'audio', track.audioFile))));
    writeFileSync(join(dataDir, 'audio', tracks[0].audioFile), wave(10));
    await assert.rejects(assembleMix({ id: 'short', plan }, tracks, dataDir), { code: 'errorSessionLength' });
    assert.equal(existsSync(join(dataDir, 'audio', 'short-mix.wav')), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('HTTP sessions keep generating without a browser and block manual generation while reserved', async () => {
  const dataDir = directory(), jobs = [];
  let release = false;
  const engine = createServer(async (req, res) => {
    if (req.url === '/v1/model_inventory') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: { models: [{ name: 'acestep-v15-turbo', is_loaded: true }] } })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const value = body ? JSON.parse(body) : {};
    const path = new URL(req.url, 'http://localhost').pathname;
    let data;
    if (path === '/release_task') { jobs.push(value); data = { task_id: 'job-' + jobs.length }; }
    else if (path === '/query_result') data = value.task_id_list.map(task_id => ({ task_id, status: release ? 1 : 0, result: JSON.stringify([{ file: '/v1/audio?path=test.wav' }]) }));
    else if (path === '/v1/audio') { res.end(wave(20)); return; }
    else data = { status: 'ok' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data }));
  });
  let studio;
  async function post(base, path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  try {
    engine.listen(0, '127.0.0.1'); await once(engine, 'listening');
    studio = createStudio({ dataDir, engineURL: 'http://127.0.0.1:' + engine.address().port, canMix: false, sessionPollMs: 10 });
    studio.listen(0, '127.0.0.1'); await once(studio, 'listening');
    const base = 'http://127.0.0.1:' + studio.address().port;
    const request = { input, minutes: 1, mode: 'tracks', segmentSeconds: 20, tempo: { enabled: true, min: 150, max: 200 } };
    assert.equal((await post(base, '/api/sessions', { ...request, mode: 'mix' })).data.errorCode, 'errorFfmpeg');
    assert.equal((await post(base, '/api/sessions', { ...request, texture: { grain: 'light', chance: 100 } })).data.errorCode, 'errorFfmpeg');
    assert.equal(jobs.length, 0);
    const created = await post(base, '/api/sessions', request);
    assert.equal(created.status, 202);
    assert.equal((await post(base, '/api/generate', input)).status, 409);
    assert.equal((await post(base, '/api/sessions', request)).status, 409);
    release = true;
    await until(() => {
      const sessions = JSON.parse(readFileSync(join(dataDir, 'sessions.json')));
      return sessions[0].status === 'complete';
    });
    assert.equal(jobs.length, 3);
    assert.ok(jobs.every(job => job.bpm >= 150 && job.bpm <= 200 && job.prompt.includes(job.bpm + ' BPM')));
    const sessions = await (await fetch(base + '/api/sessions')).json();
    assert.equal(sessions.sessions[0].completedCount, 3);
    const library = await (await fetch(base + '/api/tracks')).json();
    assert.equal(library.length, 3);
    assert.deepEqual(library.map(track => track.input.seed).reverse(), [900, 901, 902]);
    const metadata = await (await fetch(base + '/api/sessions/' + created.data.id + '/metadata')).json();
    assert.equal(metadata.tracks.length, 3);
  } finally {
    if (studio?.listening) { studio.closeAllConnections(); await new Promise(resolve => studio.close(resolve)); }
    engine.closeAllConnections(); await new Promise(resolve => engine.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('restart reconnects an accepted track even if its session checkpoint was interrupted', async () => {
  const dataDir = directory();
  const plan = sessionPlan({ minutes: 1, mode: 'tracks', segmentSeconds: 60 });
  const state = { id: 'interrupted', input, plan, status: 'running', nextIndex: 0, trackIds: [], currentTrackId: null, submissionUnknown: true };
  writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify([state]));
  const tracks = [{ id: 'accepted', status: 'ready', sessionId: state.id, sessionIndex: 0 }];
  let manager;
  try {
    manager = createSessionManager({
      dataDir, listTracks: () => tracks, canMix: false, pollMs: 5,
      submitTrack() { assert.fail('Must not resubmit accepted work'); },
      async syncTrack() {},
    });
    assert.deepEqual(manager.list()[0].trackIds, ['accepted']);
    assert.equal(manager.list()[0].completedCount, 1);
    manager.control(state.id, 'resume');
    await until(() => manager.get(state.id).status === 'complete');
  } finally { manager?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('stop saves the current track but never submits the next; assembly retries reuse saved tracks', async () => {
  const dataDir = directory(), tracks = [];
  let submissions = 0, assemblyCalls = 0, finish = false, manager;
  const dependencies = {
    dataDir, listTracks: () => tracks, canMix: true, pollMs: 5,
    async submitTrack(value, extra) {
      submissions++;
      const track = { id: 'track-' + submissions, status: 'pending', input: value, ...extra };
      tracks.push(track); return track;
    },
    async syncTrack(track) { if (finish) track.status = 'ready'; },
    async assemble() {
      assemblyCalls++;
      if (assemblyCalls === 1) throw Object.assign(new Error('fixture failure'), { code: 'errorSessionMix' });
      return { audioFile: 'mixed.wav', duration: 60 };
    },
  };
  try {
    manager = createSessionManager(dependencies);
    const stopped = manager.start(input, sessionPlan({ minutes: 1, mode: 'tracks', segmentSeconds: 20 }));
    await until(() => submissions === 1 && manager.get(stopped.id).currentTrackId);
    manager.control(stopped.id, 'stop'); finish = true;
    await until(() => manager.get(stopped.id).status === 'stopped');
    assert.equal(submissions, 1);
    assert.equal(tracks[0].status, 'ready');
    const mix = manager.start(input, sessionPlan({ minutes: 1, mode: 'mix', segmentSeconds: 60 }));
    await until(() => manager.get(mix.id).status === 'paused');
    const savedCount = submissions;
    assert.equal(manager.get(mix.id).errorCode, 'errorSessionMix');
    manager.control(mix.id, 'resume');
    await until(() => manager.get(mix.id).status === 'complete');
    assert.equal(submissions, savedCount);
    assert.equal(assemblyCalls, 2);
    assert.ok(manager.list().find(session => session.id === mix.id).audioURL);
  } finally { manager?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
