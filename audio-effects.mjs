import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runFfmpeg, audioDuration } from './audio-mix.mjs';
import { appendBackground } from './audio-background.mjs';
import { hasBackground } from './public/background-noise.js';
import { hasEnding, endingSeconds } from './public/ending.js';
import { appendEnding } from './audio-ending.mjs';

export async function renderTexture(track, texture, dataDir, signal) {
  if (texture.grain === 'off' && !texture.events.length && !hasBackground(texture.background) && !hasEnding(texture.ending)) return {};
  const source = join(dataDir, 'audio', track.audioFile);
  const expectedSeconds = hasEnding(texture.ending) ? await audioDuration(source, signal) : track.input.duration;
  if (track.sessionId && Math.abs(expectedSeconds - track.input.duration) > 1) throw Object.assign(new Error('Unexpected source duration'), { code: 'errorTextureLength' });
  const file = track.id + (hasEnding(texture.ending) ? '-finished.wav' : hasBackground(texture.background) ? '-background.wav' : '-vintage.wav');
  const output = join(dataDir, 'audio', file);
  const temporary = output + '.tmp';
  const filters = ['[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[clean]'];
  let previous = 'clean';
  for (const [index, event] of texture.events.entries()) {
    const id = 'e' + index;
    filters.push('[' + previous + ']asplit=3[' + id + 'pre][' + id + 'loop][' + id + 'post]');
    filters.push('[' + id + 'pre]atrim=end_sample=' + event.start + ',asetpts=PTS-STARTPTS[' + id + 'a]');
    filters.push('[' + id + 'loop]atrim=start_sample=' + event.start + ':end_sample=' + (event.start + event.size) + ',asetpts=PTS-STARTPTS,aloop=loop=' + (event.repeats - 1) + ':size=' + event.size + ':start=0,atrim=end_sample=' + (event.size * event.repeats) + ',asetpts=PTS-STARTPTS[' + id + 'b]');
    filters.push('[' + id + 'post]atrim=start_sample=' + (event.start + event.size * event.repeats) + ',asetpts=PTS-STARTPTS[' + id + 'c]');
    previous = id + 'out';
    filters.push('[' + id + 'a][' + id + 'b][' + id + 'c]concat=n=3:v=0:a=1[' + previous + ']');
  }
  if (texture.grain !== 'off') {
    const worn = texture.grain === 'worn';
    filters.push('[' + previous + ']highpass=f=' + (worn ? 70 : 30) + ',lowpass=f=' + (worn ? 8500 : 14000) + ',volume=' + (worn ? 1.12 : 1.04) + ',asoftclip=type=tanh:threshold=0.95:output=0.98[body]');
    filters.push('anoisesrc=color=pink:amplitude=' + (worn ? 0.016 : 0.006) + ':sample_rate=44100:duration=' + expectedSeconds + ':seed=' + texture.noiseSeed + '[hiss]');
    filters.push('[body][hiss]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97:level=0:latency=1[textured]');
    previous = 'textured';
  }
  previous = appendBackground(filters, previous, texture.background, expectedSeconds, texture.noiseSeed);
  previous = appendEnding(filters, previous, texture.ending, expectedSeconds);
  const args = ['-hide_banner', '-nostdin', '-y', '-filter_complex_threads', '1', '-i', source,
    '-filter_complex', filters.join(';'), '-map', '[' + previous + ']', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le',
    '-progress', 'pipe:1', '-f', 'wav', temporary];
  try {
    const duration = await runFfmpeg(args, signal, 'errorTextureRender');
    if (Math.abs(duration - expectedSeconds) > 1) throw Object.assign(new Error('Unexpected texture duration'), { code: 'errorTextureLength' });
    renameSync(temporary, output);
    return { processedAudioFile: file, texture, processedDuration: duration, endingAppliedSeconds: hasEnding(texture.ending) ? endingSeconds(texture.ending, expectedSeconds) : undefined };
  } finally { rmSync(temporary, { force: true }); }
}
