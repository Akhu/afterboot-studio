import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import yauzl from 'yauzl';
import { createSessionExporter, encodeSessionMp3 } from '../session-export.mjs';
import { safeFileStem, sessionTrackTitle, sessionTrackFilename, completedSessionTracks } from '../public/session-names.js';
import { ffmpegAvailable, runFfmpeg, audioDuration } from '../audio-mix.mjs';
import { createStudio } from '../server.mjs';

function fixture(count = 3) {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-export-')); mkdirSync(join(dataDir, 'audio'));
  const tracks = Array.from({ length: count }, (_, index) => ({ id: 'track-' + index, sessionId: 'session-export', sessionIndex: index, status: 'ready',
    audioFile: index + '.wav', input: { title: 'legacy UUID title', format: 'wav', duration: 3, bpm: 170, seed: index, prompt: 'Instrumental jungle' }, createdAt: new Date().toISOString() }));
  for (const track of tracks) writeFileSync(join(dataDir, 'audio', track.audioFile), 'original-' + track.id);
  const session = { id: 'session-export', input: { title: 'Nuit d’été / 1999' }, plan: { durations: tracks.map(() => 3), mode: 'tracks' },
    trackIds: tracks.map(track => track.id), nextIndex: tracks.length, status: 'complete' };
  return { dataDir, tracks, session };
}
const cleanup = path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
async function unzip(buffer) {
  const zip = await yauzl.fromBufferPromise(buffer);
  const result = [];
  for await (const entry of zip.eachEntry()) {
    const stream = await zip.openReadStreamPromise(entry), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    result.push({ name: entry.fileName, data: Buffer.concat(chunks) });
  }
  return result;
}

test('session names keep ordered suffixes, Unicode, and safe filenames on every platform', () => {
  assert.equal(sessionTrackTitle('Night drive', 0, 20), 'Night drive - 01');
  assert.equal(sessionTrackTitle('Night drive', 9, 120), 'Night drive - 010');
  assert.equal(sessionTrackFilename('Nuit d’été / 1999', 1, 3), 'Nuit d’été - 1999 - 02.mp3');
  assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(safeFileStem('../CON: <test>\\..')));
  assert.equal(safeFileStem('CON'), 'Afterboot - CON');
  const long = sessionTrackFilename('🎵'.repeat(100), 10, 120);
  assert.ok(Buffer.byteLength(long) < 255);
  assert.ok(long.endsWith(' - 011.mp3'));
  assert.equal(safeFileStem('...'), 'Afterboot session');
});

test('ZIP export is ordered, deduplicates requests, caches safely and never changes sources', async () => {
  const { dataDir, session, tracks } = fixture();
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const encode = async (track, destination, metadata) => {
    calls++; if (calls === 1) await gate;
    writeFileSync(destination, JSON.stringify({ source: track.audioFile, ...metadata }));
  };
  let exporter = createSessionExporter({ dataDir, encode });
  try {
    const failed = { ...tracks[1], id: 'failed-attempt', status: 'failed' };
    session.trackIds.splice(1, 0, failed.id);
    const all = [tracks[2], failed, tracks[1], tracks[0]];
    const first = exporter.prepare(session, all), duplicate = exporter.prepare(session, all);
    assert.equal(exporter.status(session.id).status, 'preparing');
    await assert.rejects(exporter.prepare({ ...session, id: 'other-session' }, all), { code: 'errorExportBusy' });
    release(); await Promise.all([first, duplicate]);
    assert.equal(calls, 3);
    const archive = exporter.file(session.id);
    const entries = await unzip(readFileSync(archive.path));
    assert.deepEqual(entries.map(entry => entry.name), ['Nuit d’été - 1999 - 01.mp3', 'Nuit d’été - 1999 - 02.mp3', 'Nuit d’été - 1999 - 03.mp3']);
    assert.deepEqual(entries.map(entry => JSON.parse(entry.data).number), [1, 2, 3]);
    for (const track of tracks) assert.equal(readFileSync(join(dataDir, 'audio', track.audioFile), 'utf8'), 'original-' + track.id);
    assert.ok(readdirSync(join(dataDir, 'exports')).every(file => file.endsWith('.zip')));
    exporter.close(); exporter = createSessionExporter({ dataDir, encode });
    await exporter.prepare(session, tracks); assert.equal(calls, 3, 'A restart must reuse the unchanged archive');
    tracks[1].processedAudioFile = 'finished.wav'; writeFileSync(join(dataDir, 'audio', 'finished.wav'), 'new processed audio');
    await exporter.prepare(session, tracks); assert.equal(calls, 6, 'Changed processed audio must invalidate the archive');
    assert.equal(readdirSync(join(dataDir, 'exports')).filter(file => file.endsWith('.zip')).length, 1);
  } finally { release(); exporter.close(); await cleanup(dataDir); }
});

test('partial exports include only finalized tracks; failures can retry without regenerating', async () => {
  const { dataDir, session, tracks } = fixture();
  let fail = true, calls = 0;
  const exporter = createSessionExporter({ dataDir, async encode(track, destination) {
    calls++; if (fail) throw new Error('fixture: encoder failure');
    writeFileSync(destination, track.id);
  } });
  try {
    await assert.rejects(exporter.prepare({ ...session, status: 'running' }, tracks), { code: 'errorExportSession' });
    await assert.rejects(exporter.prepare({ ...session, nextIndex: 0 }, tracks), { code: 'errorExportEmpty' });
    const paused = { ...session, status: 'paused', nextIndex: 1 };
    assert.equal(completedSessionTracks(paused, tracks).length, 1);
    await assert.rejects(exporter.prepare(paused, tracks), { code: 'errorExportRender' });
    assert.equal(exporter.status(session.id).status, 'error');
    assert.deepEqual(readdirSync(join(dataDir, 'exports')), []);
    fail = false;
    await exporter.prepare(paused, tracks);
    const entries = await unzip(readFileSync(exporter.file(session.id).path));
    assert.deepEqual(entries.map(entry => entry.name), ['Nuit d’été - 1999 - 01.mp3']);
    assert.equal(calls, 2);
  } finally { exporter.close(); await cleanup(dataDir); }
});

function wave(silent = false) {
  const data = Buffer.alloc(44 + 3 * 8000 * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  if (!silent) for (let i = 0; i < 24000; i++) data.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 / 4000) * 4000), 44 + i * 2);
  return data;
}
test('real FFmpeg exports WAV, FLAC, MP3 and processed copies as playable tagged MP3 files', { skip: !ffmpegAvailable() }, async () => {
  const { dataDir, session, tracks } = fixture(4);
  const exporter = createSessionExporter({ dataDir });
  try {
    writeFileSync(join(dataDir, 'audio', '0.wav'), wave());
    await runFfmpeg(['-y', '-i', join(dataDir, 'audio', '0.wav'), '-c:a', 'flac', join(dataDir, 'audio', '1.flac')]);
    tracks[1].audioFile = '1.flac'; tracks[1].input.format = 'flac';
    await encodeSessionMp3(tracks[0], join(dataDir, 'audio', '2.mp3'), { title: 'Raw MP3', album: 'Source', number: 1, total: 1 }, dataDir);
    tracks[2].audioFile = '2.mp3'; tracks[2].input.format = 'mp3';
    tracks[3].audioFile = 'invalid-original.mp3'; tracks[3].input.format = 'mp3';
    writeFileSync(join(dataDir, 'audio', tracks[3].audioFile), 'Must use processed copy');
    tracks[3].processedAudioFile = '3-finished.wav'; writeFileSync(join(dataDir, 'audio', tracks[3].processedAudioFile), wave(true));
    await exporter.prepare(session, tracks);
    const entries = await unzip(readFileSync(exporter.file(session.id).path));
    assert.equal(entries.length, 4);
    for (const [index, entry] of entries.entries()) {
      assert.equal(entry.data.toString('ascii', 0, 3), 'ID3');
      const path = join(dataDir, index + '-export.mp3'); writeFileSync(path, entry.data);
      assert.ok(Math.abs(await audioDuration(path) - 3) < 0.05);
      const metadata = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-i', path, '-f', 'ffmetadata', '-'], { encoding: 'utf8' });
      assert.equal(metadata.status, 0);
      assert.ok(metadata.stdout.includes('track=' + (index + 1) + '/4'));
      assert.ok(metadata.stdout.includes('album=' + session.input.title));
    }
  } finally { exporter.close(); await cleanup(dataDir); }
});

test('HTTP download provides one ZIP, readable numbered titles, Unicode filenames and persistent cache', async () => {
  const { dataDir, session, tracks } = fixture(2);
  writeFileSync(join(dataDir, 'library.json'), JSON.stringify(tracks)); writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify([session]));
  let studio, calls = 0;
  const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
  const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  const post = base => fetch(base + '/api/sessions/' + session.id + '/mp3', { method: 'POST' });
  const mp3Encoder = async (track, path) => { calls++; writeFileSync(path, 'MP3-' + track.id); };
  try {
    studio = createStudio({ dataDir, canMix: false }); let base = await listen(studio);
    assert.equal((await (await post(base)).json()).errorCode, 'errorFfmpeg');
    await close(studio); studio = createStudio({ dataDir, canMix: true, mp3Encoder }); base = await listen(studio);
    const library = await (await fetch(base + '/api/tracks')).json();
    assert.equal(library[0].displayTitle, 'Nuit d’été / 1999 - 01');
    const result = await (await post(base)).json(); assert.equal(result.status, 'ready');
    const response = await fetch(base + result.downloadURL), buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(Number(response.headers.get('content-length')), buffer.length);
    const name = response.headers.get('content-disposition').split("filename*=UTF-8''")[1];
    assert.equal(decodeURIComponent(name), 'Nuit d’été - 1999.zip');
    assert.equal((await unzip(buffer)).length, 2);
    const individual = await fetch(base + library[0].audioURL + '?download');
    await individual.arrayBuffer();
    assert.ok(individual.headers.get('content-disposition').includes(encodeURIComponent('Nuit d’été - 1999 - 01.wav')));
    await close(studio); studio = createStudio({ dataDir, canMix: true, mp3Encoder }); base = await listen(studio);
    await post(base); assert.equal(calls, 2);
  } finally { if (studio?.listening) await close(studio); await cleanup(dataDir); }
});
