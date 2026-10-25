export function sessionPlan({ minutes, mode, segmentSeconds, crossfadeSeconds = 4 }) {
  const fail = () => { throw Object.assign(new Error('errorSessionPlan'), { code: 'errorSessionPlan', status: 400 }); };
  if (!['tracks', 'mix'].includes(mode) || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) fail();
  if (!Number.isInteger(segmentSeconds) || segmentSeconds < 10 || segmentSeconds > 600) fail();
  if (!Number.isInteger(crossfadeSeconds) || crossfadeSeconds < 0 || crossfadeSeconds > 12) fail();
  const fade = mode === 'mix' ? crossfadeSeconds : 0;
  if (fade * 2 >= segmentSeconds) fail();
  const targetSeconds = minutes * 60;
  const count = Math.max(1, Math.ceil((targetSeconds - fade) / (segmentSeconds - fade)));
  const total = targetSeconds + (count - 1) * fade;
  const durations = Array.from({ length: count }, (_, index) => Math.floor(total / count) + (index < total % count ? 1 : 0));
  return { mode, targetSeconds, crossfadeSeconds: fade, durations };
}
