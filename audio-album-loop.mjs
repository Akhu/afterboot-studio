import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { audioDuration, runFfmpeg } from './audio-mix.mjs';
import { appendBackground } from './audio-background.mjs';
import { appendEnding } from './audio-ending.mjs';

const fail = () => { throw Object.assign(new Error('errorAlbumLoop'), { code: 'errorAlbumLoop' }); };

// Cache short bodies and pair transitions, then stream a concat manifest. A two-hour
// mix never decodes every occurrence simultaneously or repeatedly rewrites its prefix.
export async function assembleAlbumLoop(session, tracks, dataDir, signal) {
  const { order, crossfadeSeconds: fade, minutes } = session.plan.loop;
  if (!order?.length || tracks.length !== session.plan.durations.length) fail();
  const seconds = minutes * 60, rate = 44100;
  const work = mkdtempSync(join(dataDir, 'audio', session.id + '-loop-work-'));
  const output = join(dataDir, 'audio', session.id + '-loop.wav'), temporary = output + '.tmp';
  const files = [], cache = new Map();
  const sources = tracks.map(track => join(dataDir, 'audio', track.audioFile));
  const durations = session.plan.durations;
  const common = ['-hide_banner', '-nostdin', '-y', '-filter_complex_threads', '1'];
  const wav = ['-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav'];
  async function piece(key, inputs, filter) {
    if (!cache.has(key)) {
      const path = join(work, key + '.wav');
      await runFfmpeg([...common, ...inputs.flatMap(source => ['-i', source]), '-filter_complex', filter, '-map', '[out]', ...wav, path], signal, 'errorAlbumLoop');
      cache.set(key, path);
    }
    files.push(cache.get(key));
  }
  const trim = (input, start, end, label) => `[${input}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=${Math.round(start * rate)}:end_sample=${Math.round(end * rate)},asetpts=PTS-STARTPTS[${label}]`;
  try {
    for (let index = 0; index < sources.length; index++) {
      if (Math.abs(await audioDuration(sources[index], signal, 'errorAlbumLoop') - durations[index]) > 0.1) fail();
    }
    for (let position = 0; position < order.length; position++) {
      const index = order[position], first = position === 0, last = position === order.length - 1;
      if (!Number.isInteger(index) || !sources[index]) fail();
      const start = first ? 0 : fade, end = durations[index] - (last ? 0 : fade);
      await piece(`body-${index}-${first ? 'first' : 'next'}-${last ? 'last' : 'next'}`, [sources[index]], trim(0, start, end, 'out'));
      if (!last && fade) {
        const next = order[position + 1];
        await piece(`transition-${index}-${next}`, [sources[index], sources[next]],
          trim(0, durations[index] - fade, durations[index], 'left') + ';' + trim(1, 0, fade, 'right') + `;[left][right]acrossfade=d=${fade}:c1=tri:c2=tri[out]`);
      }
    }
    const manifest = join(work, 'playlist.ffconcat');
    writeFileSync(manifest, 'ffconcat version 1.0\n' + files.map(path => "file '" + path.replace(/'/g, "'\\''") + "'").join('\n') + '\n');
    const filters = [`[0:a]atrim=end_sample=${seconds * rate},asetpts=PTS-STARTPTS[body]`];
    let previous = appendBackground(filters, 'body', session.plan.background, seconds, session.input.seed);
    previous = appendEnding(filters, previous, session.plan.ending, seconds);
    await runFfmpeg([...common, '-f', 'concat', '-safe', '0', '-i', manifest, '-filter_complex', filters.join(';'), '-map', `[${previous}]`, ...wav, temporary], signal, 'errorAlbumLoop');
    const measured = await audioDuration(temporary, signal, 'errorAlbumLoop');
    if (Math.abs(measured - seconds) > 1 / rate) fail();
    renameSync(temporary, output);
    return { audioFile: session.id + '-loop.wav', duration: measured };
  } finally { rmSync(temporary, { force: true }); rmSync(work, { recursive: true, force: true }); }
}
