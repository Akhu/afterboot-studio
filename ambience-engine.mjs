import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export const ambienceRevision = '790793b89ddceea612be9ce42ff6830d18f6fa57';
const python = join(root, '.venv-ambiences/bin/python');
const script = join(root, '.stable-audio-src/optimized/mlx/scripts/sa3_mlx.py');
const validation = join(root, '.data/ambience-validation.json');
export function ambienceStatus() {
  let validated = false;
  try {
    const value = JSON.parse(readFileSync(validation, 'utf8'));
    validated = value.revision === ambienceRevision && value.backend === 'mlx' && value.models?.includes('small-music') && value.models?.includes('small-sfx');
  } catch {}
  return { installed: existsSync(python) && existsSync(script), validated, backend: 'mlx', revision: ambienceRevision };
}
function failure(code) { return Object.assign(new Error(code), { code, status: 503 }); }

// One process per take: --free-models releases each stage, exit releases Metal memory.
export function renderAmbience(track, dataDir, onPhase, signal) {
  if (!ambienceStatus().installed) throw failure('errorAmbienceInstall');
  if (!ambienceStatus().validated) throw failure('errorAmbienceValidation');
  const filename = `${track.id}.wav`;
  const output = join(dataDir, 'audio', filename);
  const temporary = output + '.tmp.wav';
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-u', script, '--dit', track.input.model === 'small-music' ? 'sm-music' : 'sm-sfx', '--decoder', 'same-s', '--seconds', String(track.input.duration), '--seed', String(track.input.seed), '--prompt', track.generationPrompt, '--out', temporary, '--free-models'], {
      cwd: root, env: { ...process.env, HF_HOME: join(root, '.cache-ambiences/huggingface'), HF_HUB_OFFLINE: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], signal,
    });
    let log = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20 * 60 * 1000);
    const capture = chunk => {
      log = (log + chunk.toString()).slice(-12000);
      if (/\[4\/5\]/.test(log)) onPhase('decoding');
      else if (/\[3\/5\]/.test(log)) onPhase('generating');
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', () => { clearTimeout(timer); rmSync(temporary, { force: true }); reject(failure('errorAmbienceRun')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !existsSync(temporary)) {
        rmSync(temporary, { force: true });
        const auth = /GatedRepo|401|403|gated repo|authentication/i.test(log);
        reject(failure(auth ? 'errorAmbienceAuth' : timedOut ? 'errorAmbienceTimeout' : 'errorAmbienceRun')); return;
      }
      renameSync(temporary, output);
      resolve({ audioFile: filename, returnedSeed: track.input.seed, engineResult: { backend: 'mlx', revision: ambienceRevision, model: track.input.model, sampleRate: 44100, channels: 2 } });
    });
  });
}
