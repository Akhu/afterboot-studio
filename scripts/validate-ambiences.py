"""Real MLX smoke tests, never simulated. Run with the project venv."""
import json
import os
import platform
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
REVISION = '790793b89ddceea612be9ce42ff6830d18f6fa57'
STATUS = ROOT / '.data/ambience-validation.json'
os.environ['HF_HOME'] = str(ROOT / '.cache-ambiences/huggingface')
STATUS.parent.mkdir(exist_ok=True)
STATUS.unlink(missing_ok=True)


def assert_ace_idle():
    url = os.environ.get('ACESTEP_API_URL', 'http://127.0.0.1:8001') + '/v1/stats'
    key = os.environ.get('ACESTEP_API_KEY')
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + key} if key else {})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            value = json.load(response)
        stats = value.get('data', value)
        assert stats['queue_size'] == 0 and stats['jobs']['queued'] == 0 and stats['jobs']['running'] == 0
    except Exception:
        raise SystemExit('ACE-Step doit être accessible et au repos. / ACE-Step must be reachable and idle.') from None


results = []
for model, dit, prompt in [
    ('small-music', 'sm-music', 'Ethereal sustained ambient drone, warm slowly evolving synthesizer pads, no drums, no percussion, no vocals.'),
    ('small-sfx', 'sm-sfx', 'Continuous soft wind through a dark empty valley, low distant rumble, no music, no speech, no impacts.'),
]:
    assert_ace_idle()
    target = ROOT / '.data' / f'ambience-validation-{model}.wav'
    start = time.monotonic()
    subprocess.run([sys.executable, '-u', str(ROOT / '.stable-audio-src/optimized/mlx/scripts/sa3_mlx.py'),
                    '--dit', dit, '--decoder', 'same-s', '--seconds', '5', '--seed', '12345',
                    '--prompt', prompt, '--out', str(target), '--free-models'], check=True, timeout=1200)
    audio, sr = sf.read(target, always_2d=True)
    assert sr == 44100 and audio.shape == (220500, 2), 'Invalid duration or channels'
    assert np.isfinite(audio).all() and np.max(np.abs(audio)) > 0.001, 'Silent or invalid output'
    results.append({'model': model, 'seconds': 5, 'wallSeconds': round(time.monotonic() - start, 3), 'seed': 12345,
                    'rms': float(np.sqrt(np.mean(audio ** 2))), 'file': target.name})

status = {'backend': 'mlx', 'revision': REVISION, 'models': [r['model'] for r in results],
          'platform': platform.platform(), 'machine': platform.machine(), 'results': results}
temporary = STATUS.with_suffix('.tmp')
temporary.write_text(json.dumps(status, indent=2) + '\n')
temporary.replace(STATUS)
print('Deux générations réelles validées. / Two real generations validated.')
