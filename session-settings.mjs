import { randomInt } from 'node:crypto';

export function needsTexture(plan) {
  return Boolean(plan.texture?.chance > 0 && (plan.texture.grain !== 'off' || plan.texture.cdSkips));
}
export function createTrackSettings(input, plan, draw = randomInt) {
  return plan.durations.map(duration => {
    const bpm = plan.tempo?.enabled ? draw(plan.tempo.min, plan.tempo.max + 1) : input.bpm;
    const texture = { grain: 'off', noiseSeed: 1, events: [] };
    if (plan.texture?.grain !== undefined && plan.texture.grain !== 'off' && draw(0, 100) < plan.texture.chance) {
      texture.grain = plan.texture.grain;
      texture.noiseSeed = draw(1, 2147483647);
    }
    if (plan.texture?.cdSkips && draw(0, 100) < plan.texture.chance) {
      const count = Math.max(1, Math.floor(duration / 100));
      for (let index = 0; index < count; index++) {
        const size = Math.max(3000, Math.min(6000, Math.round(44100 * 60 / bpm / 4)));
        const position = (index + draw(35, 66) / 100) * duration / count;
        texture.events.push({ start: Math.round(position * 44100), size, repeats: draw(3, 5) });
      }
    }
    return { bpm, texture };
  });
}
export function trackPrompt(prompt, bpm, varyTempo) {
  if (!varyTempo) return prompt;
  const tempo = /\b\d{2,3}(?:\.\d+)?(?:\s*[-–]\s*\d{2,3}(?:\.\d+)?)?\s*bpm\b/gi;
  return tempo.test(prompt) ? prompt.replace(tempo, bpm + ' BPM') : prompt + '\nTarget tempo: ' + bpm + ' BPM.';
}
