const presets = {
  music: 'Ethereal ambient drone, distant shimmering synthesizer pads, warm sustained chords, extremely slow tonal movement, spacious reverb, hazy early-2000s home-video nostalgia, dreamy and slightly melancholic. Continuous soft texture, no drums, no beat, no vocals, no sudden changes.',
  sfx: 'A continuous soft atmospheric soundscape of distant low rumbling wind and warm analog tape hiss, gently shifting filtered noise, spacious and enveloping, steady low intensity, no music, no voices, no sudden sounds.',
};

export function createAmbienceWorkspace({ api, t, reportError, toast, onTrack, isBusy, fillList }) {
  const $ = id => document.getElementById(id);
  let available = false, checked = false, canMix = false, submitting = false, checking = false;
  let values;
  function input() {
    return {
      mode: $('ambience-mode').value, title: $('ambience-title').value, prompt: $('ambience-prompt').value,
      duration: Number($('ambience-duration').value), randomSeed: $('ambience-random-seed').checked, seed: Number($('ambience-seed').value),
      background: { type: $('ambience-noise').value, levelDb: Number($('ambience-noise-volume').value) },
      ending: { seconds: Number($('ambience-ending').value) },
    };
  }
  function restore(saved = {}) {
    $('ambience-mode').value = saved.mode === 'sfx' ? 'sfx' : 'music';
    $('ambience-title').value = saved.title || '';
    $('ambience-prompt').value = saved.prompt ?? presets[$('ambience-mode').value];
    $('ambience-duration').value = saved.duration ?? 60;
    $('ambience-seed').value = saved.seed ?? 12345;
    $('ambience-random-seed').checked = saved.randomSeed ?? true;
    $('ambience-noise').value = saved.background?.type || 'off';
    $('ambience-noise-volume').value = saved.background?.levelDb ?? -32;
    const seconds = saved.ending?.seconds ?? 0;
    $('ambience-ending').querySelectorAll('[data-custom-ending]').forEach(option => option.remove());
    if (![0, 3, 6, 10].includes(seconds)) {
      const option = document.createElement('option'); option.value = seconds; option.textContent = seconds + ' s'; option.dataset.customEnding = '';
      $('ambience-ending').append(option);
    }
    $('ambience-ending').value = seconds;
    update();
  }
  function update() {
    values = input();
    $('ambience-seed').disabled = values.randomSeed;
    $('ambience-noise-volume').disabled = values.background.type === 'off';
    $('ambience-noise-level').textContent = values.background.levelDb + ' dB';
    $('ambience-noise-volume').setAttribute('aria-valuetext', values.background.levelDb + ' dB');
    $('ambience-model').textContent = values.mode === 'sfx' ? 'SMALL-SFX' : 'SMALL-MUSIC';
    $('ambience-mode-hint').textContent = t(values.mode === 'sfx' ? 'ambienceSfxHint' : 'ambienceMusicHint');
    $('ambience-prompt-count').textContent = t('characters', { count: values.prompt.length });
    $('ambience-health').textContent = t(!checked ? 'ambienceChecking' : available ? 'ambienceInstalled' : 'ambienceNotInstalled');
    $('ambience-health').className = 'ambience-health ' + (available ? 'available' : '');
    $('ambience-ffmpeg').hidden = canMix;
    const needsMix = values.background.type !== 'off' || values.ending.seconds > 0;
    $('ambience-generate').disabled = submitting || isBusy() || !available || (needsMix && !canMix);
    $('ambience-generate').textContent = t(submitting ? 'sending' : isBusy() ? 'ambienceBusy' : 'ambienceGenerate');
    try { localStorage.setItem('afterboot-ambience-draft-v1', JSON.stringify(values)); } catch {}
  }
  async function health() {
    if (checking) return;
    checking = true; $('ambience-recheck').disabled = true;
    try {
      const result = await api('/api/ambiences/health', undefined, 20000);
      available = result.available; canMix = result.canMix;
    } catch { available = false; }
    finally {
      if (!checked && !available) $('ambience-install').open = true;
      checked = true; checking = false; $('ambience-recheck').disabled = false; update();
    }
  }
  function render(tracks) {
    const ambiences = tracks.filter(track => track.input.engine === 'stable-audio-3');
    fillList('ambience-tracks', ambiences.slice(0, 3), t('ambienceEmpty'));
    const pending = ambiences.find(track => track.status === 'pending');
    $('ambience-activity').hidden = !pending && !submitting;
    if (pending) {
      $('ambience-activity-title').textContent = pending.input.title;
      $('ambience-activity-detail').textContent = t({ loading: 'ambienceLoading', generating: 'ambienceGenerating', processing: 'ambienceProcessing' }[pending.phase] || 'ambienceGenerating');
    }
    update();
  }
  $('ambience-mode').addEventListener('change', () => {
    // Preserve a custom prompt; switch only the untouched starting example.
    if (Object.values(presets).includes($('ambience-prompt').value)) $('ambience-prompt').value = presets[$('ambience-mode').value];
    update();
  });
  $('ambience-example').addEventListener('click', () => { $('ambience-prompt').value = presets[$('ambience-mode').value]; update(); });
  $('ambience-roll-seed').addEventListener('click', () => {
    $('ambience-random-seed').checked = false;
    $('ambience-seed').value = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647;
    update();
  });
  $('ambience-form').addEventListener('input', update);
  $('ambience-form').addEventListener('change', update);
  $('ambience-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || isBusy()) return;
    if (input().ending.seconds > input().duration) { toast(t('errorAmbienceOptions'), true); return; }
    submitting = true; update();
    try {
      const request = input(); request.title = request.title.trim() || t('ambienceUntitled');
      const track = await api('/api/ambiences/generate', request);
      onTrack(track);
    } catch (error) { reportError(error); }
    finally { submitting = false; update(); }
  });
  $('ambience-recheck').addEventListener('click', health);
  let draft;
  try { draft = JSON.parse(localStorage.getItem('afterboot-ambience-draft-v1')); } catch {}
  restore(draft || {});
  return { restore, render, update, health };
}
