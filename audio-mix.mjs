import { spawn, spawnSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const executable = () => process.env.FFMPEG_PATH || 'ffmpeg';
export function ffmpegAvailable() {
  return spawnSync(executable(), ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}
export async function assembleMix(session, tracks, dataDir, signal) {
  const output = join(dataDir, 'audio', session.id + '-mix.wav');
  const temporary = output + '.tmp';
  const args = ['-hide_banner', '-nostdin', '-y', '-filter_complex_threads', '1'];
  const filters = [];
  tracks.forEach((track, index) => {
    args.push('-i', join(dataDir, 'audio', track.audioFile));
    filters.push('[' + index + ':a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=' + session.plan.durations[index] + ',asetpts=PTS-STARTPTS[a' + index + ']');
  });
  let previous = 'a0';
  for (let index = 1; index < tracks.length; index++) {
    const next = 'x' + index;
    filters.push('[' + previous + '][a' + index + ']' + (session.plan.crossfadeSeconds
      ? 'acrossfade=d=' + session.plan.crossfadeSeconds + ':c1=tri:c2=tri'
      : 'concat=n=2:v=0:a=1') + '[' + next + ']');
    previous = next;
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[' + previous + ']', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-progress', 'pipe:1', '-f', 'wav', temporary);
  try {
    const duration = await new Promise((resolve, reject) => {
      const child = spawn(executable(), args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
      let progress = '', diagnostics = '';
      child.stdout.on('data', chunk => { progress = (progress + chunk).slice(-12000); });
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(Object.assign(new Error('Audio assembly failed: ' + diagnostics), { code: 'errorSessionMix' }));
        const times = [...progress.matchAll(/out_time_us=(\d+)/g)];
        resolve(Number(times.at(-1)?.[1] || 0) / 1000000);
      });
    });
    if (Math.abs(duration - session.plan.targetSeconds) > 1) {
      throw Object.assign(new Error('Unexpected mixed duration'), { code: 'errorSessionLength', params: { seconds: Math.round(duration), target: session.plan.targetSeconds } });
    }
    renameSync(temporary, output);
    return { audioFile: session.id + '-mix.wav', duration };
  } finally { rmSync(temporary, { force: true }); }
}
