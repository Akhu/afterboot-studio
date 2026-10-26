import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createStudio, generationInput } from '../server.mjs';

const input = { title: 'Night session', prompt: 'Atmospheric jungle, no vocals', duration: 60, bpm: 170, randomSeed: false, seed: 12345, thinking: true, format: 'wav' };
async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function request(base, path, body, headers = {}) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, data: await response.json() };
}
function requestWithHost(base, host) {
  return new Promise((resolve, reject) => {
    httpRequest(base + '/api/tracks', { headers: { Host: host } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject).end();
  });
}
test('refuses invalid audio durations, tempos and seeds before contacting the model', () => {
  for (const patch of [{ duration: 0 }, { duration: 601 }, { bpm: 0 }, { bpm: 301 }, { seed: -1 }, { format: 'exe' }, { prompt: '' }, { randomSeed: 'false' }]) {
    assert.throws(() => generationInput({ ...input, ...patch }));
  }
  const value = generationInput({ ...input, randomSeed: true });
  assert.ok(Number.isInteger(value.seed) && value.seed >= 0);
});

test('official API contract: submit, poll, archive audio and exact metadata, restore after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterboot-test-'));
  let received, polls = 0, mode = 'success';
  const audio = Buffer.from('RIFF-test-audio-data-WAVE');
  const fake = createServer(async (req, res) => {
    if (req.url === '/v1/model_inventory') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: { models: [{ name: 'acestep-v15-turbo', is_loaded: true }] } })); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v1/audio') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(audio); }
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'reject') return res.end(JSON.stringify({ code: 500, error: 'Model not initialized' }));
    let data;
    if (url.pathname === '/health') data = { status: 'ok' };
    else if (url.pathname === '/release_task') {
      received = payload;
      data = { task_id: 'engine-job-123', status: 'queued' };
    } else if (url.pathname === '/query_result') {
      assert.deepEqual(payload.task_id_list, ['engine-job-123']);
      polls += 1;
      data = [{ task_id: 'engine-job-123', status: polls === 1 ? 0 : 1, result: JSON.stringify([{ file: '/v1/audio?path=%2Ftmp%2Fgenerated.wav', seed_value: '12345', metas: { bpm: 170, duration: 60 }, prompt: received.prompt }]) }];
    } else { res.writeHead(404); return res.end('{}'); }
    res.end(JSON.stringify({ code: 200, error: null, data }));
  });
  let studio;
  try {
    const engineURL = await listen(fake);
    studio = createStudio({ engineURL, dataDir: directory });
    let base = await listen(studio);
    assert.equal((await request(base, '/api/health')).data.online, true);
    const created = await request(base, '/api/generate', input);
    assert.equal(created.response.status, 202);
    assert.equal(received.use_random_seed, false);
    assert.equal(received.seed, 12345);
    assert.equal(received.lyrics, '[Instrumental]');
    assert.equal(received.audio_duration, 60);
    assert.equal(received.batch_size, 1);
    const id = created.data.id;
    assert.equal((await request(base, '/api/tracks/' + id + '/refresh', {})).data.status, 'pending');
    const complete = await request(base, '/api/tracks/' + id + '/refresh', {});
    assert.equal(complete.data.status, 'ready');
    assert.equal(complete.data.returnedSeed, '12345');
    assert.equal(complete.data.engineResult.seed_value, '12345');
    const downloaded = await fetch(base + complete.data.audioURL);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), audio);
    const ranged = await fetch(base + complete.data.audioURL, { headers: { Range: 'bytes=5-8' } });
    assert.equal(ranged.status, 206);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), audio.subarray(5, 9));
    const invalidRange = await fetch(base + complete.data.audioURL, { headers: { Range: 'bytes=999-' } });
    assert.equal(invalidRange.status, 416);
    const meta = await request(base, '/api/tracks/' + id + '/metadata');
    assert.equal(meta.data.input.prompt, input.prompt);
    assert.equal(meta.data.input.seed, 12345);
    assert.equal((await request(base, '/api/tracks/' + id + '/favorite', {})).data.favorite, true);
    assert.equal((await request(base, '/api/generate', input, { Origin: 'https://unrelated.example' })).response.status, 403);
    await close(studio);
    studio = createStudio({ engineURL, dataDir: directory });
    base = await listen(studio);
    const library = (await request(base, '/api/tracks')).data;
    assert.equal(library.length, 1);
    assert.equal(library[0].favorite, true);
    assert.equal(library[0].status, 'ready');
    assert.deepEqual(readFileSync(join(directory, 'audio', id + '.wav')), audio);
    mode = 'reject';
    assert.equal((await request(base, '/api/generate', input)).response.status, 502);
    assert.equal((await request(base, '/api/tracks')).data.length, 1);
  } finally {
    if (studio?.listening) await close(studio);
    await close(fake);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing engine produces an actionable error and leaves the library empty', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterboot-offline-'));
  const unused = createServer();
  const engineURL = await listen(unused);
  await close(unused);
  const studio = createStudio({ engineURL, dataDir: directory });
  try {
    const base = await listen(studio);
    const result = await request(base, '/api/generate', input);
    assert.equal(result.response.status, 503);
    assert.match(result.data.error, /8001/);
    assert.equal(result.data.errorCode, 'errorEngineOffline');
    assert.deepEqual(result.data.errorParams, {});
    assert.deepEqual((await request(base, '/api/tracks')).data, []);
  } finally { await close(studio); rmSync(directory, { recursive: true, force: true }); }
});

test('LAN is opt-in and still rejects unrelated hosts and cross-origin mutations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterboot-lan-'));
  const local = createStudio({ dataDir: join(directory, 'local') });
  const lan = createStudio({ dataDir: join(directory, 'lan'), lan: true });
  try {
    const localBase = await listen(local);
    const lanBase = await listen(lan, '0.0.0.0');
    assert.equal(await requestWithHost(lanBase, 'unrelated.example'), 403);
    assert.equal((await request(lanBase, '/api/generate', input, { Origin: 'https://unrelated.example' })).response.status, 403);
    const address = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address;
    if (address) {
      assert.equal(await requestWithHost(localBase, address), 403);
      const networkBase = `http://${address}:${lan.address().port}`;
      assert.deepEqual((await request(networkBase, '/api/tracks')).data, []);
      const rejectedInput = await request(networkBase, '/api/generate', { ...input, prompt: '' }, { Origin: networkBase });
      assert.equal(rejectedInput.response.status, 400);
      assert.equal(rejectedInput.data.errorCode, 'errorPrompt');
    }
  } finally {
    if (local.listening) await close(local);
    if (lan.listening) await close(lan);
    rmSync(directory, { recursive: true, force: true });
  }
});
