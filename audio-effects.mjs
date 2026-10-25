import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runFfmpeg } from './audio-mix.mjs';

export async function renderTexture(track, texture, dataDir, signal) {
  if (texture.grain === 'off' && !texture.events.length) return {};
  const file = track.id + '-vintage.wav';
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
    filters.push('anoisesrc=color=pink:amplitude=' + (worn ? 0.016 : 0.006) + ':sample_rate=44100:duration=' + track.input.duration + ':seed=' + texture.noiseSeed + '[hiss]');
    filters.push('[body][hiss]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97:level=0:latency=1[textured]');
    previous = 'textured';
  }
  const args = ['-hide_banner', '-nostdin', '-y', '-filter_complex_threads', '1', '-i', join(dataDir, 'audio', track.audioFile),
    '-filter_complex', filters.join(';'), '-map', '[' + previous + ']', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le',
    '-progress', 'pipe:1', '-f', 'wav', temporary];
  try {
    const duration = await runFfmpeg(args, signal, 'errorTextureRender');
    if (Math.abs(duration - track.input.duration) > 1) throw Object.assign(new Error('Unexpected texture duration'), { code: 'errorTextureLength' });
    renameSync(temporary, output);
    return { processedAudioFile: file, texture };
  } finally { rmSync(temporary, { force: true }); }
}
