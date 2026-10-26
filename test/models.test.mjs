import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio, generationInput } from '../server.mjs';
import { engineModels, prepareMusicModel } from '../engine-models.mjs';

const standard = 'acestep-v15-turbo', xl = 'acestep-v15-xl-turbo';
const input = { title: 'XL comparison', prompt: 'Instrumental ambient synth pads', bpm: 90, duration: 10, seed: 42, randomSeed: false, thinking: true, format: 'wav' };
const inventory = loaded => ({ models: [standard, xl].map(name => ({ name, is_loaded: name === loaded })) });
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('model choice preserves older clients and rejects unsupported models', () => {
  assert.equal(generationInput(input).model, standard);
  assert.equal(generationInput({ ...input, model: xl }).model, xl);
  for (const model of [null, '', '../checkpoint', 'acestep-v15-xl-sft', { name: xl }]) {
    assert.throws(() => generationInput({ ...input, model }), { code: 'errorMusicModel' });
  }
});

test('inventory limits the UI to supported installed Turbo models', async () => {
  const models = await engineModels(async () => ({ models: [{ name: xl, is_loaded: true }, { name: 'acestep-v15-xl-sft' }] }));
  assert.deepEqual(models.map(({ id, available, loaded }) => ({ id, available, loaded })), [
    { id: standard, available: false, loaded: false }, { id: xl, available: true, loaded: true },
  ]);
  await assert.rejects(engineModels(async () => ({ models: null })), { code: 'errorModelInventory' });
});

test('switching never loads an absent model or replaces a busy engine', async () => {
  const calls = [];
  const engine = async path => {
    calls.push(path);
    return path === '/v1/model_inventory' ? inventory(standard) : { queue_size: 1, jobs: { queued: 1, running: 0 } };
  };
  await prepareMusicModel(engine, standard);
  assert.deepEqual(calls, ['/v1/model_inventory']);
  calls.length = 0;
  await assert.rejects(prepareMusicModel(engine, xl), { code: 'errorModelBusy' });
  assert.deepEqual(calls, ['/v1/model_inventory', '/v1/stats']);
  await assert.rejects(prepareMusicModel(async () => ({ models: [] }), xl), { code: 'errorModelUnavailable' });
});

test('HTTP selects XL before submission, returns to standard, and keeps choices across restart and sessions', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'afterboot-models-'));
  const jobs = [], switches = [];
  let loaded = standard, initFailure = false, studio;
  const engine = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    let data;
    if (req.url === '/v1/model_inventory') data = inventory(loaded);
    else if (req.url === '/v1/stats') data = { queue_size: 0, jobs: { queued: 0, running: 0 } };
    else if (req.url === '/v1/init') {
      assert.equal(body.init_llm, false, 'Keep the already loaded 4B planner');
      assert.equal(body.slot, 1);
      switches.push(body.model);
      if (!initFailure) loaded = body.model;
      data = { loaded_model: loaded };
    } else if (req.url === '/release_task') {
      assert.equal(body.model, loaded, 'Never silently generate with the wrong model');
      assert.equal(body.inference_steps, 8);
      jobs.push(body); data = { task_id: 'job-' + jobs.length };
    } else if (req.url === '/query_result') data = body.task_id_list.map(task_id => ({ task_id, status: 1, result: [{ file: '/v1/audio?path=source.wav' }] }));
    else if (req.url.startsWith('/v1/audio')) { res.end('RIFF-test-WAVE'); return; }
    else { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data }));
  });
  try {
    const engineURL = await listen(engine);
    studio = createStudio({ engineURL, dataDir, canMix: false, sessionPollMs: 10 });
    let base = await listen(studio);
    const models = await (await fetch(base + '/api/models')).json();
    assert.equal(models.models.find(model => model.id === xl).available, true);
    const generated = await post(base, '/api/generate', { ...input, model: xl });
    assert.equal(generated.status, 202);
    const track = await generated.json();
    assert.equal(track.input.model, xl);
    await post(base, '/api/generate', { ...input, model: xl });
    assert.deepEqual(switches, [xl], 'Already loaded model is reused');
    await post(base, '/api/generate', input);
    assert.deepEqual(switches, [xl, standard]);
    initFailure = true;
    const rejected = await post(base, '/api/generate', { ...input, model: xl });
    assert.equal((await rejected.json()).errorCode, 'errorModelLoad');
    assert.equal(jobs.length, 3, 'Failed initialization never submits or archives a generation');
    initFailure = false;
    await close(studio);
    studio = createStudio({ engineURL, dataDir, canMix: false, sessionPollMs: 10 }); base = await listen(studio);
    const saved = await (await fetch(base + '/api/tracks/' + track.id + '/metadata')).json();
    assert.equal(saved.input.model, xl);
    for (const item of await (await fetch(base + '/api/tracks')).json()) await post(base, '/api/tracks/' + item.id + '/refresh', {});
    const sessionResponse = await post(base, '/api/sessions', { mode: 'tracks', minutes: 1, segmentSeconds: 10, input: { ...input, model: xl } });
    assert.equal(sessionResponse.status, 202);
    assert.equal((await sessionResponse.json()).input.model, xl);
    let complete = false;
    for (let count = 0; count < 100 && !complete; count++) {
      complete = (await (await fetch(base + '/api/sessions')).json()).sessions[0].status === 'complete';
      if (!complete) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(complete, true);
    assert.equal(jobs.length, 9);
    assert.ok(jobs.slice(3).every(job => job.model === xl), 'Every session track uses its saved model');
  } finally {
    if (studio?.listening) await close(studio);
    await close(engine);
    await rm(dataDir, { recursive: true, force: true });
  }
});
