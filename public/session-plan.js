import { backgroundNoise } from './background-noise.js';

export function sessionPlan({ minutes, mode, segmentSeconds, crossfadeSeconds = 4, tempo = {}, texture = {}, background = {} }) {
  const fail = () => { throw Object.assign(new Error('errorSessionPlan'), { code: 'errorSessionPlan', status: 400 }); };
  if (!['tracks', 'mix'].includes(mode) || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) fail();
  if (!Number.isInteger(segmentSeconds) || segmentSeconds < 10 || segmentSeconds > 600) fail();
  if (!Number.isInteger(crossfadeSeconds) || crossfadeSeconds < 0 || crossfadeSeconds > 12) fail();
  if (!tempo || typeof tempo !== 'object' || Array.isArray(tempo) || (tempo.enabled !== undefined && typeof tempo.enabled !== 'boolean')) fail();
  const tempoRange = { enabled: tempo.enabled ?? false, min: tempo.min ?? 150, max: tempo.max ?? 200 };
  if (tempoRange.enabled && (!Number.isInteger(tempoRange.min) || !Number.isInteger(tempoRange.max) || tempoRange.min < 30 || tempoRange.max > 300 || tempoRange.min > tempoRange.max)) {
    throw Object.assign(new Error('errorTempoRange'), { code: 'errorTempoRange', status: 400 });
  }
  if (!texture || typeof texture !== 'object' || Array.isArray(texture)) fail();
  const textureSettings = { grain: texture.grain ?? 'off', cdSkips: texture.cdSkips ?? false, chance: texture.chance ?? 35 };
  if (!['off', 'light', 'worn'].includes(textureSettings.grain) || typeof textureSettings.cdSkips !== 'boolean' || !Number.isInteger(textureSettings.chance) || textureSettings.chance < 0 || textureSettings.chance > 100) {
    throw Object.assign(new Error('errorTextureOptions'), { code: 'errorTextureOptions', status: 400 });
  }
  const fade = mode === 'mix' ? crossfadeSeconds : 0;
  if (fade * 2 >= segmentSeconds) fail();
  const targetSeconds = minutes * 60;
  const count = Math.max(1, Math.ceil((targetSeconds - fade) / (segmentSeconds - fade)));
  const total = targetSeconds + (count - 1) * fade;
  const durations = Array.from({ length: count }, (_, index) => Math.floor(total / count) + (index < total % count ? 1 : 0));
  return { mode, targetSeconds, crossfadeSeconds: fade, durations, tempo: tempoRange, texture: textureSettings, background: backgroundNoise(background) };
}
