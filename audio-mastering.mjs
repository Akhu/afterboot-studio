import { spawn } from 'node:child_process';
import { hasMastering, masteringSettings } from './public/mastering.js';

// Measure the same seeded effects and compression used by the final render.
// Loudness is matched before adding the noise bed and the final fade.
export function measureLoudness(source, filters, input, settings, signal) {
  const compression = settings.compression ? 'acompressor=threshold=0.125:ratio=2:attack=30:release=300:makeup=1,' : '';
  const graph = [...filters, '[' + input + ']' + compression + 'loudnorm=I=' + settings.targetLufs + ':TP=-1.5:LRA=11:print_format=json[measure]'].join(';');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-nostdin', '-filter_complex_threads', '1', '-i', source, '-filter_complex', graph, '-map', '[measure]', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
    child.on('error', error => reject(Object.assign(error, { code: 'errorMasteringRender' })));
    child.on('close', code => {
      if (code !== 0) return reject(Object.assign(new Error('Loudness analysis failed: ' + diagnostics), { code: 'errorMasteringRender' }));
      try {
        const match = diagnostics.match(/\{\s*"input_i"[\s\S]*?\}/);
        if (!match) throw new Error('Missing loudness measurements');
        resolve(JSON.parse(match[0]));
      } catch (error) { reject(Object.assign(error, { code: 'errorMasteringRender' })); }
    });
  });
}

export async function appendMastering(filters, input, source, value, signal) {
  const settings = masteringSettings(value);
  if (!hasMastering(settings)) return input;
  const measured = await measureLoudness(source, filters, input, settings, signal);
  const keys = { input_i: 'measured_I', input_tp: 'measured_TP', input_lra: 'measured_LRA', input_thresh: 'measured_thresh', target_offset: 'offset' };
  const valid = Object.keys(keys).every(key => Number.isFinite(Number(measured[key])));
  const chain = settings.compression ? ['acompressor=threshold=0.125:ratio=2:attack=30:release=300:makeup=1'] : [];
  // Silence has -inf LUFS. Keep it silent rather than feeding invalid gains to FFmpeg.
  if (valid) chain.push('loudnorm=I=' + settings.targetLufs + ':TP=-1.5:LRA=11:linear=true:' + Object.entries(keys).map(([key, name]) => name + '=' + Number(measured[key])).join(':'));
  chain.push('aresample=44100');
  filters.push('[' + input + ']' + chain.join(',') + '[mastered]');
  return 'mastered';
}

export function appendPeakGuard(filters, input, settings) {
  if (!hasMastering(settings)) return input;
  // Oversample the final sum, including noise, to catch inter-sample peaks.
  filters.push('[' + input + ']aresample=192000,alimiter=limit=' + 10 ** (-1 / 20) + ':level=0:latency=1,aresample=44100[limited]');
  return 'limited';
}
