import { spawn, spawnSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendBackground } from './audio-background.mjs';
import { appendEnding } from './audio-ending.mjs';
import { hasEnding, endingSeconds } from './public/ending.js';

const executable = () => process.env.FFMPEG_PATH || 'ffmpeg';
export function ffmpegAvailable() {
  return spawnSync(executable(), ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}
export function runFfmpeg(args, signal, errorCode = 'errorSessionMix') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable(), args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let progress = '', diagnostics = '';
    child.stdout.on('data', chunk => { progress = (progress + chunk).slice(-12000); });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
    child.on('error', error => reject(Object.assign(error, { code: errorCode })));
    child.on('close', code => {
      if (code !== 0) return reject(Object.assign(new Error('Audio processing failed: ' + diagnostics), { code: errorCode }));
      const samples = [...progress.matchAll(/lavfi\.astats\.Overall\.Number_of_samples=(\d+)/g)];
      if (samples.length) return resolve(Number(samples.at(-1)[1]) / 44100);
      const times = [...progress.matchAll(/out_time_us=(\d+)/g)];
      resolve(Number(times.at(-1)?.[1] || 0) / 1000000);
    });
  });
}
export async function audioDuration(path, signal, errorCode = 'errorTextureRender') {
  // Older FFmpeg progress timestamps can point to the start of the final frame.
  // Count decoded samples instead, at the same rate used by the output renderer.
  const measure = 'aresample=44100,aformat=channel_layouts=mono,astats=metadata=1:reset=0:measure_perchannel=none:measure_overall=Number_of_samples,ametadata=mode=print:key=lavfi.astats.Overall.Number_of_samples:file=-';
  const duration = await runFfmpeg(['-hide_banner', '-nostdin', '-i', path, '-map', '0:a:0', '-vn', '-af', measure, '-f', 'null', '-'], signal, errorCode);
  if (!Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error('Invalid audio duration'), { code: errorCode });
  return duration;
}
export async function assembleMix(session, tracks, dataDir, signal) {
  const output = join(dataDir, 'audio', session.id + '-mix.wav');
  const temporary = output + '.tmp';
  const args = ['-hide_banner', '-nostdin', '-y', '-filter_complex_threads', '1'];
  const filters = [];
  let measuredSeconds = 0;
  for (const [index, track] of tracks.entries()) {
    const source = join(dataDir, 'audio', track.processedAudioFile || track.audioFile);
    args.push('-i', source);
    if (hasEnding(session.plan.ending)) measuredSeconds += Math.min(session.plan.durations[index], await audioDuration(source, signal, 'errorSessionMix'));
    filters.push('[' + index + ':a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=' + session.plan.durations[index] + ',asetpts=PTS-STARTPTS[a' + index + ']');
  }
  const finalSeconds = hasEnding(session.plan.ending) ? measuredSeconds - (tracks.length - 1) * session.plan.crossfadeSeconds : session.plan.targetSeconds;
  if (Math.abs(finalSeconds - session.plan.targetSeconds) > 1) throw Object.assign(new Error('Unexpected source duration'), { code: 'errorSessionLength', params: { seconds: Math.round(finalSeconds), target: session.plan.targetSeconds } });
  let previous = 'a0';
  for (let index = 1; index < tracks.length; index++) {
    const next = 'x' + index;
    filters.push('[' + previous + '][a' + index + ']' + (session.plan.crossfadeSeconds
      ? 'acrossfade=d=' + session.plan.crossfadeSeconds + ':c1=tri:c2=tri'
      : 'concat=n=2:v=0:a=1') + '[' + next + ']');
    previous = next;
  }
  previous = appendBackground(filters, previous, session.plan.background, session.plan.targetSeconds, session.input?.seed ?? 1);
  previous = appendEnding(filters, previous, session.plan.ending, finalSeconds);
  args.push('-filter_complex', filters.join(';'), '-map', '[' + previous + ']', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-progress', 'pipe:1', '-f', 'wav', temporary);
  try {
    const duration = await runFfmpeg(args, signal);
    if (Math.abs(duration - session.plan.targetSeconds) > 1) {
      throw Object.assign(new Error('Unexpected mixed duration'), { code: 'errorSessionLength', params: { seconds: Math.round(duration), target: session.plan.targetSeconds } });
    }
    renameSync(temporary, output);
    return { audioFile: session.id + '-mix.wav', duration, endingAppliedSeconds: hasEnding(session.plan.ending) ? endingSeconds(session.plan.ending, finalSeconds) : undefined };
  } finally { rmSync(temporary, { force: true }); }
}
