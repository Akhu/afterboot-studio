export function backgroundNoise(value = {}) {
  const fail = () => { throw Object.assign(new Error('errorBackgroundOptions'), { code: 'errorBackgroundOptions', status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const settings = { type: value.type ?? 'off', levelDb: value.levelDb ?? -32 };
  if (!['off', 'white', 'pink', 'brown', 'dark'].includes(settings.type) || !Number.isInteger(settings.levelDb) || settings.levelDb < -60 || settings.levelDb > -12) fail();
  return settings;
}

export function hasBackground(value) {
  return Boolean(value?.type && value.type !== 'off');
}
