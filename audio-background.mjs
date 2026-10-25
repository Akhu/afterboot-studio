import { backgroundNoise, hasBackground } from './public/background-noise.js';

// Insert once after music processing, so crossfades and CD skips never gate the bed.
export function appendBackground(filters, input, settings, seconds, seed) {
  const background = backgroundNoise(settings);
  if (!hasBackground(background)) return input;
  const amplitude = 10 ** (background.levelDb / 20);
  const color = background.type === 'dark' ? 'brown' : background.type;
  const shaping = background.type === 'dark' ? ',highpass=f=20,lowpass=f=180' : '';
  filters.push('anoisesrc=color=' + color + ':amplitude=' + amplitude + ':sample_rate=44100:duration=' + seconds + ':seed=' + seed + shaping + ',aformat=sample_fmts=fltp:channel_layouts=stereo[background]');
  filters.push('[' + input + '][background]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97:level=0:latency=1[withbackground]');
  return 'withbackground';
}
