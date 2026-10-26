import { musicModel, musicModels } from './public/music-models.js';

function fail(code, status, params = {}) {
  throw Object.assign(new Error(code), { code, status, params });
}

export async function engineModels(engine) {
  const inventory = await engine('/v1/model_inventory');
  if (!Array.isArray(inventory.models)) fail('errorModelInventory', 502);
  return musicModels.map(model => {
    const installed = inventory.models.find(item => item.name === model.id);
    return { ...model, available: Boolean(installed), loaded: installed?.is_loaded === true };
  });
}

export async function prepareMusicModel(engine, value) {
  const model = musicModel(value);
  const available = (await engineModels(engine)).find(item => item.id === model);
  if (!available.available) fail('errorModelUnavailable', 409, { model });
  if (available.loaded) return;
  // Switching the primary handler must wait until ACE's own queue is idle.
  const stats = await engine('/v1/stats');
  if (stats.queue_size !== 0 || stats.jobs?.running !== 0 || stats.jobs?.queued !== 0) {
    fail('errorModelBusy', 409);
  }
  const initialized = await engine('/v1/init', { model, slot: 1, init_llm: false }, 120000);
  if (initialized.loaded_model !== model) fail('errorModelLoad', 502, { model });
}
