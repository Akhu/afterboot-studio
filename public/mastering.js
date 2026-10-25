export function masteringSettings(value = {}) {
  const fail = () => { throw Object.assign(new Error('errorMasteringOptions'), { code: 'errorMasteringOptions', status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const settings = { enabled: value.enabled ?? false, targetLufs: value.targetLufs ?? -18, compression: value.compression ?? true };
  if (typeof settings.enabled !== 'boolean' || typeof settings.compression !== 'boolean' ||
      !Number.isFinite(settings.targetLufs) || settings.targetLufs < -24 || settings.targetLufs > -14) fail();
  return settings;
}

export const hasMastering = value => value?.enabled === true;
