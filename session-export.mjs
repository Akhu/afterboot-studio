import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, statSync, existsSync, renameSync, createWriteStream } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { runFfmpeg } from './audio-mix.mjs';
import { completedSessionTracks, safeFileStem, sessionTrackFilename, sessionTrackTitle } from './public/session-names.js';

const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };

export async function encodeSessionMp3(track, destination, metadata, dataDir, signal) {
  const source = join(dataDir, 'audio', track.processedAudioFile || track.audioFile);
  const codec = !track.processedAudioFile && track.input.format === 'mp3' ? ['-c:a', 'copy'] : ['-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', '-ac', '2'];
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', source, '-map', '0:a:0', '-vn', '-map_metadata', '-1', ...codec,
    '-id3v2_version', '3', '-metadata', 'title=' + metadata.title, '-metadata', 'album=' + metadata.album,
    '-metadata', 'track=' + metadata.number + '/' + metadata.total, '-f', 'mp3', destination], signal, 'errorExportRender');
}

async function writeZip(files, destination, signal) {
  const zip = new yazl.ZipFile();
  zip.on('error', error => zip.outputStream.destroy(error));
  const writing = pipeline(zip.outputStream, createWriteStream(destination), { signal });
  try {
    for (const file of files) zip.addFile(file.path, file.name, { compress: false });
    zip.end();
    await writing;
  } catch (error) {
    zip.outputStream.destroy(error);
    await writing.catch(() => {});
    throw error;
  }
}

export function createSessionExporter({ dataDir, encode = encodeSessionMp3 }) {
  const folder = join(dataDir, 'exports');
  mkdirSync(folder, { recursive: true });
  const states = new Map(), controller = new AbortController();
  let active = null, closed = false;
  function status(id) {
    const state = states.get(id);
    if (!state) return null;
    return { status: state.status, completedCount: state.completedCount, total: state.total, errorCode: state.errorCode,
      downloadURL: state.status === 'ready' ? '/api/sessions/' + id + '/mp3' : null };
  }
  async function prepare(session, tracks) {
    if (closed) fail('errorExportBusy');
    if (!['complete', 'stopped', 'paused'].includes(session.status)) fail('errorExportSession');
    const selected = completedSessionTracks(session, tracks);
    if (!selected.length) fail('errorExportEmpty');
    let fingerprint;
    try {
      fingerprint = selected.map(track => {
        const source = track.processedAudioFile || track.audioFile;
        const info = statSync(join(dataDir, 'audio', source));
        return [track.id, track.sessionIndex, source, info.size, info.mtimeMs, track.input.format];
      });
    } catch { fail('errorExportSource'); }
    const key = createHash('sha256').update(JSON.stringify(['mp3-320-id3-v1', session.input.title, session.plan.durations.length, fingerprint])).digest('hex').slice(0, 20);
    if (active) {
      if (active.id === session.id && active.key === key) return active.promise;
      fail('errorExportBusy');
    }
    const path = join(folder, session.id + '-' + key + '.zip');
    const state = { status: 'preparing', completedCount: 0, total: selected.length, path, filename: safeFileStem(session.input.title) + '.zip' };
    states.set(session.id, state);
    if (existsSync(path)) {
      state.status = 'ready'; state.completedCount = selected.length;
      return status(session.id);
    }
    const promise = (async () => {
      const work = mkdtempSync(join(folder, session.id + '-work-'));
      try {
        const files = [];
        for (const track of selected) {
          const name = sessionTrackFilename(session.input.title, track.sessionIndex, session.plan.durations.length);
          const destination = join(work, name);
          await encode(track, destination, { title: sessionTrackTitle(session.input.title, track.sessionIndex, session.plan.durations.length),
            album: session.input.title, number: track.sessionIndex + 1, total: session.plan.durations.length }, dataDir, controller.signal);
          files.push({ path: destination, name });
          state.completedCount++;
        }
        const temporary = join(work, 'tracks.zip');
        await writeZip(files, temporary, controller.signal);
        renameSync(temporary, path);
        state.status = 'ready';
        for (const file of await readdir(folder)) {
          if (file.startsWith(session.id + '-') && file.endsWith('.zip') && join(folder, file) !== path) {
            await rm(join(folder, file), { force: true }).catch(() => {});
          }
        }
        return status(session.id);
      } catch {
        state.status = 'error'; state.errorCode = 'errorExportRender';
        fail('errorExportRender', 502);
      } finally {
        await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
      }
    })();
    active = { id: session.id, key, promise };
    try { return await promise; } finally { active = null; }
  }
  return {
    prepare, status,
    file(id) {
      const state = states.get(id);
      if (state?.status !== 'ready' || !existsSync(state.path)) fail('errorExportNotReady');
      return { path: state.path, filename: state.filename };
    },
    close() { closed = true; controller.abort(); },
  };
}
