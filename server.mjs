import { createServer as httpServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { translate } from './public/i18n.js';
import { sessionPlan } from './public/session-plan.js';
import { createSessionManager } from './session-manager.mjs';
import { assembleMix, ffmpegAvailable } from './audio-mix.mjs';
import { renderTexture } from './audio-effects.mjs';
import { backgroundNoise, hasBackground } from './public/background-noise.js';
import { endingSettings, hasEnding, musicalEndingPrompt } from './public/ending.js';
import { createSessionExporter } from './session-export.mjs';
import { safeFileStem, sessionTrackTitle, sessionTrackFilename } from './public/session-names.js';

const root = dirname(fileURLToPath(import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function attachment(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

class UserError extends Error {
  constructor(code, status = 400, params = {}) {
    super(translate('fr', code, params));
    this.code = code;
    this.status = status;
    this.params = params;
  }
}

export function generationInput(input) {
  const prompt = String(input.prompt || '').trim();
  const title = String(input.title || 'Sans titre').trim().slice(0, 100);
  const duration = Number(input.duration);
  const bpm = Number(input.bpm);
  if (!prompt || prompt.length > 6000) throw new UserError('errorPrompt');
  if (!Number.isInteger(duration) || duration < 10 || duration > 600) throw new UserError('errorDuration');
  if (!Number.isInteger(bpm) || bpm < 30 || bpm > 300) throw new UserError('errorBpm');
  if (typeof input.randomSeed !== 'boolean' || typeof input.thinking !== 'boolean') throw new UserError('errorOptions');
  const seed = input.randomSeed ? randomInt(0, 2147483647) : Number(input.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw new UserError('errorSeed');
  if (!['wav', 'flac', 'mp3'].includes(input.format)) throw new UserError('errorFormat');
  return {
    title, duration, bpm, seed, thinking: input.thinking, format: input.format,
    prompt, model: 'acestep-v15-turbo', background: backgroundNoise(input.background), ending: endingSettings(input.ending),
  };
}

function enginePayload(input) {
  return {
    prompt: musicalEndingPrompt(input.prompt, input.ending, input.duration), lyrics: '[Instrumental]', vocal_language: 'unknown',
    audio_duration: input.duration, bpm: input.bpm, time_signature: '4',
    model: input.model, task_type: 'text2music', batch_size: 1,
    audio_format: input.format, inference_steps: 8, thinking: input.thinking,
    use_random_seed: false, seed: input.seed,
    use_cot_caption: false, use_cot_language: false,
    lm_backend: process.platform === 'darwin' ? 'mlx' : 'pt',
  };
}

async function jsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32768) throw new UserError('errorBodySize', 413);
  }
  try { return JSON.parse(body); } catch { throw new UserError('errorJson'); }
}

export function createStudio({
  engineURL = process.env.ACESTEP_API_URL || 'http://127.0.0.1:8001',
  apiKey = process.env.ACESTEP_API_KEY || '',
  dataDir = join(root, '.data'),
  lan = false,
  sessionPollMs = 3000,
  mix = assembleMix,
  textureRenderer = renderTexture,
  mp3Encoder,
  canMix = ffmpegAvailable(),
} = {}) {
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (lan) {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4') allowedHosts.add(address.address);
      }
    }
  }
  const engineBase = new URL(engineURL);
  if (!['http:', 'https:'].includes(engineBase.protocol)) throw new Error('Adresse ACESTEP_API_URL invalide.');
  mkdirSync(join(dataDir, 'audio'), { recursive: true });
  const statePath = join(dataDir, 'library.json');
  let tracks = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : [];
  if (!Array.isArray(tracks)) throw new Error('Bibliothèque illisible. Le fichier a été conservé.');
  const active = new Map();
  function save() {
    writeFileSync(`${statePath}.tmp`, JSON.stringify(tracks, null, 2));
    renameSync(`${statePath}.tmp`, statePath);
  }
  function respond(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  async function engine(path, body, timeout = 20000) {
    let response;
    try {
      response = await fetch(new URL(path, engineBase), {
        method: body ? 'POST' : 'GET',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout), redirect: 'error',
      });
    } catch {
      throw new UserError('errorEngineOffline', 503);
    }
    const value = await response.json().catch(() => null);
    if (!response.ok || !value || (value.code !== undefined && Number(value.code) !== 200) || value.error) {
      const message = value?.error || value?.detail;
      if (message) throw new UserError('errorEngine', 502, { message: typeof message === 'string' ? message : JSON.stringify(message) });
      throw new UserError('errorEngineHttp', 502, { status: response.status });
    }
    return value.data ?? value;
  }
  const processingVersion = track => hasEnding(track.texture?.ending) ? 'finished' : hasBackground(track.texture?.background) ? 'background' : 'vintage';
  function publicTrack(track) {
    const version = processingVersion(track);
    const session = track.sessionId ? sessions.get(track.sessionId) : null;
    const displayTitle = session && Number.isInteger(track.sessionIndex) ? sessionTrackTitle(session.input.title, track.sessionIndex, session.plan.durations.length) : track.input.title;
    return { ...track, displayTitle, audioURL: track.audioFile ? `/api/tracks/${track.id}/audio${track.processedAudioFile ? '?version=' + version : ''}` : null,
      audioFormat: track.processedAudioFile ? 'wav' : track.input.format,
      originalAudioURL: track.processedAudioFile ? `/api/tracks/${track.id}/audio?original=1` : null,
      audioFile: undefined, processedAudioFile: undefined };
  }
  async function finishDownloadedTrack(track) {
    if (!track.sessionId && (hasBackground(track.input.background) || hasEnding(track.input.ending)) && !track.processedAudioFile) {
      try {
        await processTrack(track, { grain: 'off', events: [], noiseSeed: track.input.seed, background: track.input.background, ending: track.input.ending });
      } catch (error) { throw new UserError(hasEnding(track.input.ending) ? 'errorEndingRender' : 'errorBackgroundRender', 502); }
    }
    Object.assign(track, { status: 'ready', completedAt: new Date().toISOString() });
    save();
    return track;
  }
  async function syncTrack(track) {
    if (track.status !== 'pending') return track;
    if (active.has(track.id)) return active.get(track.id);
    const operation = (async () => {
      // A failed background render retries the archived audio, never the model.
      if (track.audioFile) return finishDownloadedTrack(track);
      const jobs = await engine('/query_result', { task_id_list: [track.taskId] });
      if (!Array.isArray(jobs)) throw new UserError('errorJobResponse', 502);
      const job = jobs.find(value => value.task_id === track.taskId);
      if (!job || ![0, 1, 2].includes(Number(job.status))) throw new UserError('errorMissingJob', 502);
      if (Number(job.status) === 0) return track;
      if (Number(job.status) === 2) {
        track.status = 'failed';
        track.errorCode = typeof job.error === 'string' ? 'errorEngine' : 'errorGenerationFailed';
        track.errorParams = typeof job.error === 'string' ? { message: job.error } : {};
        track.error = translate('fr', track.errorCode, track.errorParams);
        save();
        return track;
      }
      let results;
      try { results = typeof job.result === 'string' ? JSON.parse(job.result) : job.result; }
      catch { throw new UserError('errorResult', 502); }
      if (!Array.isArray(results) || !results[0]?.file) throw new UserError('errorMissingAudio', 502);
      const result = results[0];
      const audioURL = new URL(result.file, engineBase);
      if (audioURL.origin !== engineBase.origin || audioURL.pathname !== '/v1/audio') throw new UserError('errorAudioAddress', 502);
      const response = await fetch(audioURL, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(120000), redirect: 'error',
      });
      if (!response.ok) throw new UserError('errorAudioCopy', 502);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new UserError('errorEmptyAudio', 502);
      const audioFile = `${track.id}.${track.input.format}`;
      writeFileSync(join(dataDir, 'audio', `${audioFile}.tmp`), buffer);
      renameSync(join(dataDir, 'audio', `${audioFile}.tmp`), join(dataDir, 'audio', audioFile));
      Object.assign(track, {
        audioFile,
        returnedSeed: result.seed_value ?? null, engineResult: result,
      });
      save();
      return finishDownloadedTrack(track);
    })();
    active.set(track.id, operation);
    try { return await operation; } finally { active.delete(track.id); }
  }
  async function submitTrack(input, extra = {}) {
    const payload = enginePayload(input);
    const accepted = await engine('/release_task', payload);
    if (!accepted.task_id) throw new UserError('errorTaskId', 502);
    const track = { id: randomUUID(), taskId: accepted.task_id, input, generationPrompt: payload.prompt, ...extra, createdAt: new Date().toISOString(), status: 'pending', favorite: false };
    tracks.unshift(track); save();
    return track;
  }
  let generationSubmitting = false, finishing = false;
  async function processTrack(track, texture, signal) {
    Object.assign(track, await textureRenderer(track, texture, dataDir, signal));
    save();
  }
  const sessions = createSessionManager({ dataDir, listTracks: () => tracks, submitTrack, syncTrack, assemble: mix, processTrack, canMix, pollMs: sessionPollMs });
  const exporter = createSessionExporter({ dataDir, encode: mp3Encoder });
  const publicSessions = () => sessions.list().map(session => ({ ...session, mp3Export: exporter.status(session.id) }));
  const server = httpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Only accept this computer's addresses, including LAN IPv4 when enabled.
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (!allowedHosts.has(host)) throw new UserError('errorHost', 403);
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new UserError('errorOrigin', 403);
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const health = await engine('/health', null, 5000);
        return respond(res, 200, { online: true, health });
      }
      if (req.method === 'GET' && url.pathname === '/api/tracks') return respond(res, 200, tracks.map(publicTrack));
      if (req.method === 'GET' && url.pathname === '/api/sessions') return respond(res, 200, { sessions: publicSessions(), canMix });
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await jsonBody(req);
        if (generationSubmitting || finishing) throw new UserError('errorSessionBusy', 409);
        const plan = sessionPlan(body);
        const input = generationInput({ ...body.input, background: { type: 'off' }, ending: { seconds: 0 }, bpm: plan.tempo.enabled ? plan.tempo.min : body.input?.bpm });
        return respond(res, 202, sessions.start(input, plan));
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/(pause|resume|stop|metadata|audio|mp3)$/);
      if (sessionMatch) {
        const session = sessions.get(sessionMatch[1]);
        if (!session) throw new UserError('errorSessionNotFound', 404);
        const action = sessionMatch[2];
        if (req.method === 'POST' && action === 'mp3') {
          if (!canMix) throw new UserError('errorFfmpeg');
          return respond(res, 200, await exporter.prepare(session, tracks));
        }
        if (req.method === 'GET' && action === 'mp3') {
          const archive = exporter.file(session.id);
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': statSync(archive.path).size,
            'Content-Disposition': attachment(archive.filename), 'Cache-Control': 'no-store' });
          return createReadStream(archive.path).on('error', () => res.destroy()).pipe(res);
        }
        if (req.method === 'POST' && ['pause', 'resume', 'stop'].includes(action)) return respond(res, 200, sessions.control(session.id, action));
        if (req.method === 'GET' && action === 'metadata') {
          res.setHeader('Content-Disposition', `attachment; filename="${session.id}-session.json"`);
          return respond(res, 200, { schemaVersion: 1, session: publicSessions().find(item => item.id === session.id), tracks: tracks.filter(track => track.sessionId === session.id).map(publicTrack) });
        }
        if (req.method === 'GET' && action === 'audio' && session.audioFile) {
          const path = join(dataDir, 'audio', session.audioFile);
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': statSync(path).size, 'Content-Disposition': `attachment; filename="${session.id}-mix.wav"` });
          return createReadStream(path).on('error', () => res.destroy()).pipe(res);
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        const input = generationInput(await jsonBody(req));
        if ((hasBackground(input.background) || hasEnding(input.ending)) && !canMix) throw new UserError('errorFfmpeg');
        if (sessions.busy() || generationSubmitting || finishing) throw new UserError('errorSessionBusy', 409);
        generationSubmitting = true;
        try { return respond(res, 202, publicTrack(await submitTrack(input))); }
        finally { generationSubmitting = false; }
      }
      const match = url.pathname.match(/^\/api\/tracks\/([a-z0-9-]+)(?:\/(audio|metadata|refresh|favorite|finish))?$/);
      if (match) {
        const track = tracks.find(item => item.id === match[1]);
        if (!track) throw new UserError('errorTrackNotFound', 404);
        const action = match[2];
        if (req.method === 'GET' && action === 'metadata') {
          res.setHeader('Content-Disposition', `attachment; filename="${track.id}.json"`);
          return respond(res, 200, { schemaVersion: 1, ...publicTrack(track) });
        }
        if (req.method === 'POST' && action === 'refresh') return respond(res, 200, publicTrack(await syncTrack(track)));
        if (req.method === 'POST' && action === 'finish') {
          const ending = endingSettings(await jsonBody(req));
          if (!hasEnding(ending)) throw new UserError('errorEndingOptions');
          if (!canMix) throw new UserError('errorFfmpeg');
          if (track.status !== 'ready') throw new UserError('errorEndingReady', 409);
          if (hasEnding(track.texture?.ending)) return respond(res, 200, publicTrack(track));
          if (sessions.busy() || generationSubmitting || finishing || tracks.some(item => item.status === 'pending')) throw new UserError('errorSessionBusy', 409);
          finishing = true;
          try {
            const result = await textureRenderer({ ...track, sessionId: undefined, audioFile: track.processedAudioFile || track.audioFile }, { grain: 'off', events: [], noiseSeed: track.input.seed, ending }, dataDir);
            const texture = { ...result.texture, ...track.texture, ending };
            Object.assign(track, result, { texture }); save();
            return respond(res, 200, publicTrack(track));
          } catch (error) { throw new UserError('errorEndingRender', 502); }
          finally { finishing = false; }
        }
        if (req.method === 'POST' && action === 'favorite') {
          track.favorite = !track.favorite;
          save();
          return respond(res, 200, publicTrack(track));
        }
        if (req.method === 'GET' && action === 'audio' && track.audioFile) {
          const processed = track.processedAudioFile && !url.searchParams.has('original');
          const format = processed ? 'wav' : track.input.format;
          const path = join(dataDir, 'audio', processed ? track.processedAudioFile : track.audioFile);
          const size = statSync(path).size;
          const types = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg' };
          const headers = { 'Content-Type': types[format], 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', Vary: 'Range' };
          if (url.searchParams.has('download')) {
            const session = track.sessionId ? sessions.get(track.sessionId) : null;
            const stem = session && Number.isInteger(track.sessionIndex) ? sessionTrackFilename(session.input.title, track.sessionIndex, session.plan.durations.length).slice(0, -4) : safeFileStem(track.input.title);
            headers['Content-Disposition'] = attachment(stem + (url.searchParams.has('original') ? '-original' : '') + '.' + format);
          }
          if (req.headers.range) {
            const parts = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
            const start = parts ? Number(parts[1]) : NaN;
            const end = parts?.[2] ? Math.min(Number(parts[2]), size - 1) : size - 1;
            if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= size) {
              res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end();
            }
            res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
            return createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
          }
          res.writeHead(200, { ...headers, 'Content-Length': size });
          return createReadStream(path).on('error', () => res.destroy()).pipe(res);
        }
      }
      const staticFiles = { '/': ['index.html', '.html'], '/app.js': ['app.js', '.js'], '/background-noise.js': ['background-noise.js', '.js'], '/ending.js': ['ending.js', '.js'], '/session-names.js': ['session-names.js', '.js'], '/session-plan.js': ['session-plan.js', '.js'], '/i18n.js': ['i18n.js', '.js'], '/style.css': ['style.css', '.css'] };
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        const [file, extension] = staticFiles[url.pathname];
        res.writeHead(200, { 'Content-Type': mime[extension], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return res.end(readFileSync(join(root, 'public', file)));
      }
      throw new UserError('errorNotFound', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      respond(res, error.status || 500, {
        error: error.status ? translate('fr', error.code, error.params) : translate('fr', 'errorLocal'),
        errorCode: error.status ? error.code : 'errorLocal',
        errorParams: error.status ? error.params : {},
      });
      if (!error.status) console.error(error);
    }
  });
  server.on('close', () => { sessions.close(); exporter.close(); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3210);
  const host = process.argv.includes('--lan') ? '0.0.0.0' : process.env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('HOST must be 127.0.0.1 or 0.0.0.0.');
  const studio = createStudio({ lan: host === '0.0.0.0' }).listen(port, host, () => {
    console.log(`Afterboot Studio : http://127.0.0.1:${port}`);
    if (host === '0.0.0.0') {
      console.log('LAN mode: shared library and generation access. Use a trusted private network.');
      for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses || []) {
          if (address.family === 'IPv4' && !address.internal) console.log(`Network: http://${address.address}:${port}`);
        }
      }
    }
    console.log('Moteur ACE-Step :', process.env.ACESTEP_API_URL || 'http://127.0.0.1:8001');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    studio.closeAllConnections();
    studio.close(() => process.exit(0));
  });
}
