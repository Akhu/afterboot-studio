import { endingSeconds } from './public/ending.js';

export function appendEnding(filters, input, settings, duration) {
  const seconds = endingSeconds(settings, duration);
  if (!seconds) return input;
  filters.push('[' + input + ']afade=t=out:st=' + (duration - seconds) + ':d=' + seconds + ':curve=hsin[finished]');
  return 'finished';
}
