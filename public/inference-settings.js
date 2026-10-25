export const stableArrangement = 'Keep a stable, restrained arrangement throughout. Sparse, soft percussion with a repeated rhythmic motif and constant instrumental density. Keep the perceived pace steady. Only small changes in texture. No drum fills, rapid rolls, double-time passages, build-ups, drops or sudden increases in energy. These arrangement instructions take priority over any conflicting energy or percussion description above. Preserve the requested musical style.';

export function inferenceSettings(value = {}) {
  const fail = () => { throw Object.assign(new Error('errorInferenceOptions'), { code: 'errorInferenceOptions', status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const settings = { temperature: value.temperature ?? 0.85, topP: value.topP ?? 0.9, topK: value.topK ?? 0, arrangement: value.arrangement ?? '' };
  if (!Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2 ||
      !Number.isFinite(settings.topP) || settings.topP <= 0 || settings.topP > 1 ||
      !Number.isInteger(settings.topK) || settings.topK < 0 || settings.topK > 1000 ||
      typeof settings.arrangement !== 'string' || settings.arrangement.length > 1800) fail();
  settings.arrangement = settings.arrangement.trim();
  return settings;
}

export function arrangementPrompt(prompt, inference) {
  return inference?.arrangement ? prompt + '\nArrangement instructions: ' + inference.arrangement : prompt;
}
