import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const failure = code => Object.assign(new Error(code), { code, status: 503, params: {} });

// A separate process keeps the Python environment isolated and releases model RAM
// after each take. Only the studio chooses the script and output path.
export function createAmbienceEngine({ python = process.env.STABLE_AUDIO_PYTHON || join(root, '.stable-audio', '.venv', 'bin', 'python') } = {}) {
  const children = new Set();
  const script = join(root, 'scripts', 'stable_audio_worker.py');
  function invoke(args, input, onProgress, timeout) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, [script, ...args], {
        cwd: root, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.add(child);
      let pending = '', result, errorCode, expired = false, settled = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); children.delete(child);
        error ? reject(error) : resolve(value);
      }
      child.on('error', () => finish(failure('errorAmbienceMissing')));
      child.stdin.on('error', () => {});
      child.stderr.on('data', () => {}); // Model progress and dependency logs are not protocol messages.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        pending += chunk;
        if (pending.length > 65536) { child.kill('SIGKILL'); return; }
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.type === 'progress') onProgress?.(message.phase);
            else if (message.type === 'result') result = message;
            else if (message.type === 'error') errorCode = message.code;
          } catch { /* Ignore non-protocol output from third-party libraries. */ }
        }
      });
      child.on('close', code => {
        if (expired) return finish(failure('errorAmbienceTimeout'));
        if (code === 0 && result) return finish(null, result);
        const known = ['errorAmbienceAccess', 'errorAmbienceMissing', 'errorAmbienceMemory', 'errorAmbienceGeneration'];
        finish(failure(known.includes(errorCode) ? errorCode : 'errorAmbienceGeneration'));
      });
      child.stdin.end(input ? JSON.stringify(input) : '');
    });
  }
  return {
    async health() {
      if (python.includes('/') && !existsSync(python)) return { available: false };
      try { return await invoke(['--check'], null, null, 15000); }
      catch { return { available: false }; }
    },
    generate(input, output, onProgress) {
      return invoke([], { model: input.model, prompt: input.prompt, duration: input.duration, seed: input.seed, output }, onProgress, 30 * 60 * 1000);
    },
    close() { for (const child of children) child.kill('SIGTERM'); },
  };
}
