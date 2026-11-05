import { translate, preferredLanguage } from '/i18n.js';
import { sessionPlan } from '/session-plan.js';
import { hasBackground } from '/background-noise.js';
import { stableArrangement, inferenceSettings } from '/inference-settings.js';
import { hasMastering, masteringSettings } from '/mastering.js';
import { hasEnding } from '/ending.js';
import { completedSessionTracks, sessionTrackTitle } from '/session-names.js';
import { musicModel } from '/music-models.js';
import { ambienceAlbumSettings } from '/ambience-album.js';

const $ = (id) => document.getElementById(id);
let savedLanguage;
try { savedLanguage = localStorage.getItem('afterboot-language-v1'); } catch {}
let language = preferredLanguage(savedLanguage, navigator.languages || [navigator.language]);
const t = (key, values) => translate(language, key, values);
function uiError(code, params = {}) {
  return Object.assign(new Error(t(code, params)), { code, params });
}
function errorMessage(error) {
  return error?.code ? t(error.code, error.params) : error?.message || t('errorRequest');
}
function trackError(track) {
  return track.errorCode ? t(track.errorCode, track.errorParams) : track.error || t('errorGenerationFailed');
}
const presets = {
  jungle: { bpm: 170, prompt: 'Instrumental atmospheric jungle, 170 BPM. Drum-driven arrangement with crisp, intricate chopped breakbeats starting immediately. Fast syncopated percussion, rolling warm sub bass, energetic rhythmic movement. Dreamy digital pads and distant shimmering synthesizers remain behind the drums. Late-night futuristic racing game atmosphere from 1999. Consistent groove throughout, subtle melodic development, clean drum transients. No piano, no vocals, no spoken words, no ambient intro, no half-time sections.' },
  liquid: { bpm: 168, prompt: 'Instrumental atmospheric liquid drum and bass, 168 BPM. Crisp rolling breakbeats, warm rounded sub bass, luminous digital pads and sparse crystalline synth melodies. Dreamy late-night racing atmosphere, restrained harmony, clear rhythmic movement, subtle evolving arrangement. No vocals, no spoken words, no piano, no aggressive drops.' },
  ambient: { bpm: 110, prompt: 'Instrumental ambient techno from the late 1990s, 110 BPM. Soft rhythmic pulses, warm digital pads, gently evolving arpeggios, deep rounded bass. A quiet computer room at dawn, reflective and spacious. Subtle development, clean textures, gradual atmospheric ending. No vocals, no spoken words, no piano.' },
};
let tracks = [], online = false, connectionChecked = false, submitting = false, favoritesOnly = false, toastTimer;
let sessions = [], canMix = false, sessionRefresh = false;
let availableModels = [];
let ambienceEngine = {};
const ambiencePresets = {
  'small-music': [
    ['ambienceClouds', 'Ethereal sustained synthesizer pads, warm slowly evolving harmonies, weightless ambient drone, spacious reverb, no drums, no percussion, no vocals.'],
    ['ambienceDeep', 'Deep meditative drone, dark resonant synthesizer layers, very slow harmonic movement, soft distant shimmering overtones, no rhythm, no drums, no vocals.'],
  ],
  'small-sfx': [
    ['ambienceWind', 'Continuous soft wind through a dark empty valley, low distant rumble, steady airy noise, no music, no speech, no impacts.'],
    ['ambienceRumble', 'Continuous deep subterranean rumble, slowly shifting low frequencies, distant cavern resonance, steady dark atmospheric texture, no music, no voices, no sudden impacts.'],
  ],
};
const exportingSessions = new Set();
const polling = new Map();

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function toast(text, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').className = error ? 'toast error' : 'toast';
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 15000 : 5000);
}
async function api(path, body, timeout = 180000) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) { throw uiError(error.name === 'TimeoutError' ? 'errorTimeout' : 'errorNetwork'); }
  let data;
  try { data = await response.json(); } catch { throw uiError('errorJson'); }
  if (!response.ok) throw data.errorCode ? uiError(data.errorCode, data.errorParams) : uiError('errorEngine', { message: data.error || t('errorRequest') });
  return data;
}
function renderConnection() {
  $('connection-label').textContent = t(connectionChecked ? online ? 'engineOnline' : 'engineOffline' : 'engineConnecting');
  $('connection-button').setAttribute('aria-label', t('connectionMenu') + ' ' + $('connection-label').textContent);
  $('status-dot').className = 'status-dot' + (connectionChecked ? online ? ' online' : ' offline' : '');
  $('connection-feedback').textContent = t(connectionChecked ? online ? 'connectedFeedback' : 'offlineFeedback' : 'engineConnecting');
}
async function health() {
  try {
    await api('/api/health');
    availableModels = (await api('/api/models')).models;
    online = true;
  } catch {
    online = false;
  }
  connectionChecked = true;
  renderConnection();
  updateForm();
  return online;
}
function formValues() {
  return {
    title: $('track-title').value, prompt: $('prompt').value,
    bpm: Number($('bpm').value), duration: Number($('duration').value),
    randomSeed: $('random-seed').checked, seed: Number($('seed').value),
    thinking: $('thinking').checked, format: $('format').value, model: $('music-model').value,
    inference: { temperature: Number($('lm-temperature').value), topP: Number($('lm-top-p').value), topK: Number($('lm-top-k').value), arrangement: $('arrangement').value },
    mastering: { enabled: $('mastering-enabled').checked, targetLufs: Number($('target-lufs').value), compression: $('gentle-compression').checked },
    generationMode: $('generation-mode').value, sessionMinutes: Number($('session-minutes').value), crossfadeSeconds: Number($('crossfade').value),
    tempo: { enabled: $('vary-bpm').checked, min: Number($('bpm-min').value), max: Number($('bpm-max').value) },
    texture: { grain: $('grain').value, cdSkips: $('cd-skips').checked, chance: Number($('texture-chance').value) },
    background: { type: $('background-type').value, levelDb: Number($('background-volume').value) },
    ending: { seconds: Number($('ending-seconds').value) },
  };
}
function sessionOptions(values = formValues()) {
  return { mode: values.generationMode, minutes: values.sessionMinutes, segmentSeconds: values.duration,
    crossfadeSeconds: values.crossfadeSeconds, tempo: values.tempo, texture: values.texture, background: values.background, ending: values.ending, mastering: values.mastering };
}
function updateForm() {
  $('prompt-count').textContent = t('characters', { count: $('prompt').value.length });
  $('seed').disabled = $('random-seed').checked;
  const duration = Number($('duration').value);
  const mode = $('generation-mode').value;
  $('generation-form').querySelector('[data-i18n="trackName"]').textContent = t(mode === 'single' ? 'trackName' : 'sessionName');
  $('track-title').placeholder = t(mode === 'single' ? 'titlePlaceholder' : 'sessionTitlePlaceholder');
  $('generation-form').querySelector('[data-i18n="duration"]').textContent = t(mode === 'single' ? 'duration' : 'perTrackDuration');
  $('generation-form').querySelector('[data-i18n="randomSeed"]').textContent = t(mode === 'single' ? 'randomSeed' : 'randomSessionSeed');
  $('generation-form').querySelector('[data-i18n="seedHint"]').textContent = t(mode === 'single' ? 'seedHint' : 'sessionSeedHint');
  $('session-options').hidden = mode === 'single';
  $('bpm-range').hidden = !$('vary-bpm').checked;
  $('bpm-min').disabled = $('bpm-max').disabled = mode === 'single' || !$('vary-bpm').checked;
  $('bpm-min').required = $('bpm-max').required = mode !== 'single' && $('vary-bpm').checked;
  $('bpm').disabled = mode !== 'single' && $('vary-bpm').checked;
  $('bpm').hidden = $('bpm').disabled;
  $('bpm-range-display').hidden = !$('bpm').disabled;
  $('bpm-range-display').textContent = $('bpm-min').value + '–' + $('bpm-max').value;
  $('crossfade-option').hidden = mode !== 'mix';
  const values = formValues();
  const selectedModel = availableModels.find(model => model.id === values.model);
  for (const option of $('music-model').options) option.disabled = !availableModels.some(model => model.id === option.value && model.available);
  $('model-hint').textContent = !connectionChecked ? t('modelsChecking') : !online ? t('offlineFeedback') : !selectedModel?.available ? t('errorModelUnavailable', { model: values.model }) : t(values.model === 'acestep-v15-xl-turbo' ? 'modelXlHint' : 'modelTurboHint') + (selectedModel.loaded ? '' : ' ' + t('modelFirstLoad'));
  for (const id of ['lm-temperature', 'lm-top-p', 'lm-top-k']) $(id).disabled = !values.thinking;
  $('target-lufs').disabled = $('gentle-compression').disabled = !hasMastering(values.mastering);
  $('background-volume').disabled = !hasBackground(values.background);
  $('background-volume-display').textContent = values.background.levelDb + ' dB';
  $('background-volume').setAttribute('aria-valuetext', values.background.levelDb + ' dB');
  const effectsEnabled = values.texture.chance > 0 && (values.texture.grain !== 'off' || values.texture.cdSkips);
  $('mix-requirement').hidden = !hasMastering(values.mastering) && !hasEnding(values.ending) && !hasBackground(values.background) && (mode === 'single' || (mode !== 'mix' && !effectsEnabled));
  $('ending-hint').textContent = t(mode === 'mix' ? 'endingMixHint' : 'endingHint');
  $('mix-requirement').textContent = t(canMix ? 'mixReady' : 'mixMissing');
  if (mode !== 'single') {
    try {
      const plan = sessionPlan(sessionOptions(values));
      $('session-preview').textContent = t('sessionPreview', { count: plan.durations.length, minutes: plan.targetSeconds / 60, min: Math.min(...plan.durations), max: Math.max(...plan.durations) });
      if (plan.tempo.enabled) $('session-preview').textContent += ' ' + t('tempoRangeSummary', { min: plan.tempo.min, max: plan.tempo.max });
    } catch (error) { $('session-preview').textContent = t(error.code || 'errorSessionPlan'); }
  }
  $('duration-display').textContent = Math.floor(duration / 60) + ' min ' + String(duration % 60).padStart(2, '0');
  document.querySelectorAll('[data-duration]').forEach(button => button.classList.toggle('selected', Number(button.dataset.duration) === duration));
  document.querySelectorAll('[data-preset]').forEach(button => button.classList.toggle('active', $('prompt').value === presets[button.dataset.preset].prompt));
  try { localStorage.setItem('afterboot-draft-v1', JSON.stringify(formValues())); } catch {}
  updateActivity();
}
function setForm(input) {
  $('track-title').value = input.title || '';
  $('prompt').value = input.prompt || presets.jungle.prompt;
  $('bpm').value = input.bpm ?? 170;
  $('duration').value = input.duration ?? 60;
  $('seed').value = input.seed ?? 12345;
  $('random-seed').checked = input.randomSeed ?? true;
  $('thinking').checked = input.thinking ?? true;
  $('format').value = input.format || 'wav';
  $('music-model').value = input.model || 'acestep-v15-turbo';
  $('lm-temperature').value = input.inference?.temperature ?? 0.85;
  $('lm-top-p').value = input.inference?.topP ?? 0.9;
  $('lm-top-k').value = input.inference?.topK ?? 0;
  $('arrangement').value = input.inference?.arrangement ?? '';
  $('mastering-enabled').checked = input.mastering?.enabled ?? false;
  $('target-lufs').value = input.mastering?.targetLufs ?? -18;
  $('gentle-compression').checked = input.mastering?.compression ?? true;
  $('generation-mode').value = input.generationMode || 'single';
  $('session-minutes').value = input.sessionMinutes || 30;
  $('crossfade').value = input.crossfadeSeconds ?? 4;
  $('vary-bpm').checked = input.tempo?.enabled ?? false;
  $('bpm-min').value = input.tempo?.min ?? 150;
  $('bpm-max').value = input.tempo?.max ?? 200;
  $('grain').value = input.texture?.grain || 'off';
  $('cd-skips').checked = input.texture?.cdSkips ?? false;
  $('texture-chance').value = input.texture?.chance ?? 35;
  $('background-type').value = input.background?.type || 'off';
  $('background-volume').value = input.background?.levelDb ?? -32;
  const seconds = input.ending?.seconds ?? 6;
  $('ending-seconds').querySelectorAll('[data-custom-ending]').forEach(option => option.remove());
  if (![0, 3, 6, 10].includes(seconds)) {
    const option = node('option', '', seconds + ' s'); option.value = seconds; option.dataset.customEnding = '';
    $('ending-seconds').append(option);
  }
  $('ending-seconds').value = seconds;
  updateForm();
}
function seedOf(track) { return String(track.returnedSeed ?? track.input.seed); }
function restore(track, variation) {
  if (track.input.engine === 'stable-audio-3') {
    setAmbienceForm({ ...track.input, ending: track.texture?.ending || track.input.ending, background: track.texture?.background || track.input.background, randomSeed: variation });
    location.hash = 'ambiences'; $('ambience-title').focus(); toast(t('restoreSettings')); return;
  }
  const returnedSeed = Number(seedOf(track).split(',')[0]);
  setForm({
    ...track.input, mastering: track.texture?.mastering || track.input.mastering, ending: track.texture?.ending || track.input.ending, background: track.texture?.background || track.input.background, title: (track.displayTitle || track.input.title) + (variation ? t('variationSuffix') : ''),
    seed: Number.isInteger(returnedSeed) && returnedSeed >= 0 ? returnedSeed : track.input.seed,
    randomSeed: variation,
  });
  location.hash = 'create';
  $('track-title').focus();
  toast(t(variation ? 'restoreVariation' : 'restoreSettings'));
}
function action(label, handler, className = '') {
  const button = node('button', className, label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}
function downloadURL(url) { return url + (url.includes('?') ? '&' : '?') + 'download'; }
function textureDescription(texture) {
  const parts = [];
  if (texture?.grain && texture.grain !== 'off') parts.push(t(texture.grain === 'worn' ? 'grainWorn' : 'grainLight'));
  if (texture?.events?.length) parts.push(t('cdSkips'));
  if (hasBackground(texture?.background)) parts.push(backgroundDescription(texture.background));
  if (hasMastering(texture?.mastering)) parts.push(t('masteringSummary', { lufs: texture.mastering.targetLufs }));
  if (hasEnding(texture?.ending)) parts.push(t('endingSummary', { seconds: texture.ending.seconds }));
  return parts.join(' · ');
}
function backgroundDescription(background) {
  const key = { white: 'noiseWhite', pink: 'noisePink', brown: 'noiseBrown', dark: 'noiseDark' }[background.type];
  return t(key) + ' · ' + background.levelDb + ' dB';
}
function audioCard(track) {
  const title = track.displayTitle || track.input.title;
  const card = node('article', 'track');
  card.dataset.trackId = track.id;
  const heading = node('div', 'track-heading');
  heading.append(node('span', 'track-disc', '◎'));
  const info = node('div', 'track-info');
  info.append(node('h3', '', title));
  const meta = node('div', 'track-meta');
  meta.append(node('span', '', track.input.engine === 'stable-audio-3' ? 'Stable Audio 3 · ' + track.input.model : track.input.bpm + ' BPM'), node('span', '', track.input.duration + ' s'));
  if (track.texture) meta.append(node('span', '', textureDescription(track.texture)));
  const seedKey = (track.returnedSeed === null || track.returnedSeed === undefined) ? 'seedRequested' : 'seedReturned';
  meta.append(node('span', '', t(seedKey, { seed: seedOf(track) })));
  meta.append(node('span', '', new Date(track.createdAt).toLocaleString(language === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })));
  info.append(meta);
  const favorite = action(track.favorite ? '★' : '☆', async () => {
    try {
      const updated = await api('/api/tracks/' + track.id + '/favorite', {});
      tracks = tracks.map(item => item.id === track.id ? updated : item);
      document.querySelectorAll('[data-track-id="' + track.id + '"] .favorite').forEach(button => {
        button.textContent = updated.favorite ? '★' : '☆';
        button.setAttribute('aria-pressed', String(updated.favorite));
      });
      if (favoritesOnly) renderLibrary();
    } catch (error) { toast(errorMessage(error), true); }
  }, 'favorite');
  favorite.setAttribute('aria-label', t('favoriteTrack', { title }));
  favorite.setAttribute('aria-pressed', String(track.favorite));
  heading.append(info, favorite); card.append(heading);
  if (track.status === 'ready') {
    const audio = node('audio');
    audio.controls = true; audio.preload = 'metadata'; audio.src = track.audioURL;
    audio.addEventListener('play', () => document.querySelectorAll('audio').forEach(other => { if (other !== audio) other.pause(); }));
    audio.addEventListener('error', () => toast(t('playbackError'), true));
    card.append(audio);
  } else {
    card.append(node('p', track.status === 'failed' ? 'track-error' : 'pending-message', track.status === 'failed' ? trackError(track) : t(track.phase ? 'ambiencePhase_' + track.phase : 'waitingResult')));
  }
  const buttons = node('div', 'track-actions');
  if (track.status === 'ready') {
    const download = node('a', 'download', t('downloadAudio', { format: (track.audioFormat || track.input.format).toUpperCase() }));
    download.href = downloadURL(track.audioURL); download.setAttribute('download', '');
    buttons.append(download);
    if (track.originalAudioURL) {
      const original = node('a', '', t('downloadOriginal', { format: track.input.format.toUpperCase() }));
      original.href = downloadURL(track.originalAudioURL); original.download = ''; buttons.append(original);
    }
    if (!hasEnding(track.texture?.ending)) {
      const finish = action(t('finishExisting'), async () => {
        finish.disabled = true; finish.textContent = t('finishing');
        try {
          const updated = await api('/api/tracks/' + track.id + '/finish', { seconds: 6 });
          tracks = tracks.map(item => item.id === track.id ? updated : item);
          render(); toast(t('endingReady'));
        } catch (error) { toast(errorMessage(error), true); }
        finally { finish.disabled = false; finish.textContent = t('finishExisting'); }
      });
      buttons.append(finish);
    }
  }
  buttons.append(action(t('reuse'), () => restore(track, false)), action(t('newVariation'), () => restore(track, true)));
  const metadata = node('a', '', t('downloadSettings'));
  metadata.href = '/api/tracks/' + track.id + '/metadata'; metadata.setAttribute('download', '');
  buttons.append(metadata);
  if (track.status === 'pending') buttons.append(action(t('checkStatus'), () => startPolling(track.id)));
  card.append(buttons);
  const details = node('details', 'track-details');
  details.append(node('summary', '', t('promptDetails')));
  details.append(node('p', '', track.input.prompt));
  details.append(node('code', '', track.input.model + ' · ' + (track.input.engine === 'stable-audio-3' ? 'MLX · 8 steps · ' : t(track.input.thinking ? 'planningOn' : 'planningOff') + ' · ') + t('seedRequested', { seed: track.input.seed })));
  if (track.generationPrompt && track.generationPrompt !== track.input.prompt) details.append(node('p', 'field-note', track.generationPrompt));
  if (track.pollError) details.append(node('p', 'track-error', errorMessage(track.pollError)));
  card.append(details);
  return card;
}
function fillList(id, values, emptyMessage) {
  const container = $(id);
  const previous = [...container.querySelectorAll('audio')].filter(audio => !audio.paused).map(audio => ({ src: audio.getAttribute('src'), time: audio.currentTime }));
  container.replaceChildren();
  if (!values.length) {
    if (emptyMessage) container.append(node('p', 'field-note', emptyMessage));
    else container.append($('empty-template').content.cloneNode(true));
  } else values.forEach(track => container.append(audioCard(track)));
  previous.forEach(value => {
    const audio = [...container.querySelectorAll('audio')].find(item => item.getAttribute('src') === value.src);
    if (audio) audio.addEventListener('loadedmetadata', () => { audio.currentTime = value.time; audio.play().catch(() => {}); }, { once: true });
  });
}
function renderLibrary() {
  const term = $('search').value.toLowerCase().trim();
  const visible = tracks.filter(track => (!favoritesOnly || track.favorite) && ((track.displayTitle || track.input.title) + ' ' + track.input.prompt + ' ' + seedOf(track)).toLowerCase().includes(term));
  fillList('library-tracks', visible, tracks.length && !visible.length ? t('noMatches') : '');
  $('library-count').textContent = t(visible.length === 1 ? 'trackCountOne' : 'trackCountMany', { count: visible.length });
}
function render() {
  $('nav-count').textContent = tracks.length;
  fillList('recent-tracks', tracks.slice(0, 3));
  fillList('ambience-tracks', tracks.filter(track => track.input.engine === 'stable-audio-3').slice(0, 3));
  renderLibrary();
  updateActivity();
}
function sessionIsOpen(session) { return !['complete', 'stopped'].includes(session.status); }
function renderSessions() {
  const albums = sessions.filter(session => session.plan.kind === 'ambience-album');
  const ace = sessions.filter(session => session.plan.kind !== 'ambience-album');
  $('sessions-section').hidden = !ace.length;
  $('ambience-albums-section').hidden = $('library-albums-section').hidden = !albums.length;
  renderSessionList('session-list', ace);
  renderSessionList('ambience-album-list', albums);
  renderSessionList('library-album-list', albums);
  updateActivity();
}
function renderSessionList(id, items) {
  const list = $(id);
  list.replaceChildren();
  for (const session of items) {
    const album = session.plan.kind === 'ambience-album';
    const card = node('article', 'session-card');
    card.append(node('h3', '', session.input.title));
    if (hasMastering(session.plan.mastering)) card.append(node('p', 'field-note', t('masteringSummary', { lufs: session.plan.mastering.targetLufs })));
    if (hasBackground(session.plan.background)) card.append(node('p', 'field-note', backgroundDescription(session.plan.background)));
    if (hasEnding(session.plan.ending)) card.append(node('p', 'field-note', t('endingSummary', { seconds: session.plan.ending.seconds })));
    card.append(node('p', 'session-state', t('sessionState_' + session.status) + ' · ' + t(album ? 'albumProgress' : 'sessionProgress', { count: session.completedCount, total: session.plan.durations.length, minutes: Math.round(session.plan.targetSeconds / 60) })));
    if (album && session.plan.loop.enabled) card.append(node('p', 'field-note', t('albumLoopSummary', { minutes: session.plan.loop.minutes, fade: session.plan.loop.crossfadeSeconds })));
    const progress = node('progress');
    progress.max = session.plan.durations.length; progress.value = session.completedCount;
    progress.setAttribute('aria-label', t('sessionProgress', { count: session.completedCount, total: session.plan.durations.length, minutes: session.plan.targetSeconds / 60 }));
    card.append(progress);
    if (session.trackSettings) {
      const plan = node('details', 'session-files'); plan.append(node('summary', '', t(album ? 'albumTrackPlan' : 'trackPlan')));
      const rows = node('ol', 'track-plan');
      session.trackSettings.forEach((settings, index) => {
        rows.append(node('li', '', sessionTrackTitle(session.input.title, index, session.plan.durations.length) + (album ? '' : ' · ' + settings.bpm + ' BPM') + ' · ' + session.plan.durations[index] + ' s' + (textureDescription(settings.texture) ? ' · ' + textureDescription(settings.texture) : '')));
      });
      plan.append(rows); card.append(plan);
    }
    if (session.errorCode) card.append(node('p', 'track-error', t(session.errorCode, session.errorParams)));
    if (['running', 'pausing', 'stopping'].includes(session.status)) card.append(node('p', 'field-note', t('sessionFinishesTrack')));
    const buttons = node('div', 'track-actions');
    const control = async actionName => {
      try { await api('/api/sessions/' + session.id + '/' + actionName, {}); await refreshSessions(); }
      catch (error) { toast(errorMessage(error), true); }
    };
    if (session.status === 'running') buttons.append(action(t('sessionPause'), () => control('pause')));
    if (session.status === 'paused' && !session.submissionUnknown) buttons.append(action(t('sessionResume'), () => control('resume')));
    if (sessionIsOpen(session) && session.status !== 'assembling') buttons.append(action(t('sessionStop'), () => control('stop')));
    if (session.audioURL) {
      const download = node('a', 'download', t(album ? 'albumDownloadLoop' : 'downloadMix')); download.href = session.audioURL; download.download = ''; buttons.append(download);
    }
    if (album) buttons.append(action(t('reuse'), () => {
      setAmbienceForm({ ...session.input, randomSeed: false, outputMode: 'album', album: session.plan.album }); location.hash = 'ambiences'; $('ambience-title').focus();
    }));
    const exportable = completedSessionTracks(session, tracks);
    if (exportable.length && ['complete', 'stopped', 'paused'].includes(session.status)) {
      const exportButton = action(t(album ? 'albumDownloadZip' : 'downloadSessionMp3', { count: exportable.length }), async () => {
        exportingSessions.add(session.id); renderSessions();
        try {
          const result = await api('/api/sessions/' + session.id + '/mp3', {}, 30 * 60 * 1000);
          await refreshSessions();
          const link = node('a'); link.href = result.downloadURL; link.download = '';
          document.body.append(link); link.click(); link.remove();
          toast(t('exportDownloadStarted'));
        } catch (error) { toast(errorMessage(error), true); }
        finally { exportingSessions.delete(session.id); renderSessions(); }
      }, 'download');
      exportButton.disabled = exportingSessions.has(session.id) || session.mp3Export?.status === 'preparing';
      if (exportButton.disabled) exportButton.textContent = t('exportPreparing');
      buttons.append(exportButton);
    }
    if (session.mp3Export?.status === 'ready') {
      const archive = node('a', '', t('downloadPreparedZip')); archive.href = session.mp3Export.downloadURL; archive.download = ''; buttons.append(archive);
    }
    const metadata = node('a', '', t('downloadSessionSettings')); metadata.href = '/api/sessions/' + session.id + '/metadata'; metadata.download = ''; buttons.append(metadata);
    card.append(buttons);
    if (session.mp3Export?.status === 'preparing') card.append(node('p', 'field-note', t('exportProgress', { count: session.mp3Export.completedCount, total: session.mp3Export.total })));
    if (session.mp3Export?.status === 'error') card.append(node('p', 'track-error', t(session.mp3Export.errorCode)));
    const ready = session.trackIds.map(id => tracks.find(track => track.id === id)).filter(track => track?.status === 'ready');
    if (ready.length) {
      const files = node('details', 'session-files'); files.append(node('summary', '', t(ready.length === 1 ? 'sessionFile' : 'sessionFiles', { count: ready.length })));
      for (const track of ready) {
        const link = node('a', '', '↓ ' + (track.displayTitle || track.input.title) + (album ? ' · ' + track.input.duration + ' s' : ' · ' + track.input.bpm + ' BPM')); link.href = downloadURL(track.audioURL); link.download = ''; files.append(link);
      }
      card.append(files);
    }
    list.append(card);
  }
}
async function refreshSessions() {
  if (sessionRefresh) return;
  sessionRefresh = true;
  try {
    const data = await api('/api/sessions');
    const changed = JSON.stringify(data.sessions) !== JSON.stringify(sessions);
    canMix = data.canMix;
    if (changed) {
      const updatedTracks = await api('/api/tracks');
      sessions = data.sessions;
      tracks = updatedTracks;
      render(); renderSessions();
    }
    $('mix-requirement').textContent = t(canMix ? 'mixReady' : 'mixMissing');
    updateActivity();
  } finally { sessionRefresh = false; }
}
function updateActivity() {
  const pending = tracks.find(track => track.status === 'pending');
  const busy = submitting || Boolean(pending);
  const openSession = sessions.some(sessionIsOpen);
  const values = formValues();
  const needsFfmpeg = hasMastering(values.mastering) || hasEnding(values.ending) || hasBackground(values.background) || (values.generationMode !== 'single' && (values.generationMode === 'mix' || (values.texture.chance > 0 && (values.texture.grain !== 'off' || values.texture.cdSkips))));
  let invalidPlan = false;
  try { musicModel(values.model); inferenceSettings(values.inference); masteringSettings(values.mastering); } catch { invalidPlan = true; }
  if (!availableModels.some(model => model.id === values.model && model.available)) invalidPlan = true;
  if (values.generationMode !== 'single') {
    try { sessionPlan(sessionOptions(values)); } catch { invalidPlan = true; }
  }
  $('generate').disabled = busy || openSession || invalidPlan || (needsFfmpeg && !canMix);
  if (busy || openSession) $('generate').textContent = t(openSession ? 'sessionInProgress' : submitting ? 'sending' : 'generating');
  else {
    const icon = node('span', '', '▶');
    icon.setAttribute('aria-hidden', 'true');
    $('generate').replaceChildren(icon, document.createTextNode(' ' + t($('generation-mode').value === 'single' ? 'generate' : 'startSession')));
  }
  $('activity').hidden = !busy;
  updateAmbienceForm(busy || openSession);
  if (pending) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(pending.createdAt).getTime()) / 1000));
    $('elapsed').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    $('activity-title').textContent = pending.input.title;
    $('activity-detail').textContent = t('queueDetail', { seed: pending.input.seed });
  }
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function startPolling(id) {
  if (polling.has(id)) return;
  polling.set(id, true); updateActivity();
  let errors = 0;
  const started = Date.now();
  try {
    while (Date.now() - started < 30 * 60 * 1000) {
      try {
        const updated = await api('/api/tracks/' + id + '/refresh', {});
        errors = 0;
        tracks = tracks.map(track => track.id === id ? updated : track);
        if (updated.phase) render();
        if (updated.status !== 'pending') {
          render();
          toast(updated.status === 'ready' ? t('trackReady') : trackError(updated), updated.status === 'failed');
          return;
        }
      } catch (error) {
        errors += 1;
        if (errors >= 3) throw error;
      }
      await delay(3000);
    }
    throw uiError('pollingTimeout');
  } catch (error) {
    tracks = tracks.map(track => track.id === id ? { ...track, pollError: { code: error.code, params: error.params, message: error.message } } : track);
    toast(t('settingsKept', { message: errorMessage(error) }), true);
    render();
  } finally { polling.delete(id); updateActivity(); }
}
function route() {
  const selected = location.hash === '#library' ? 'library' : location.hash === '#ambiences' ? 'ambiences' : 'create';
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== selected; });
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.classList.toggle('active', link.dataset.nav === selected);
    if (link.dataset.nav === selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('breadcrumb').textContent = t(selected === 'ambiences' ? 'ambiences' : selected === 'library' ? 'breadcrumbLibrary' : 'breadcrumbCreate');
  $('window-document').textContent = selected === 'ambiences' ? '· ' + t('ambiences') : t(selected === 'library' ? 'windowLibrary' : 'windowCreate');
  document.querySelectorAll('audio').forEach(audio => { if (audio.closest('.view').hidden) audio.pause(); });
}
$('apply-stable').addEventListener('click', () => {
  $('thinking').checked = true;
  $('lm-temperature').value = 0.7; $('lm-top-p').value = 0.9; $('lm-top-k').value = 0;
  $('arrangement').value = stableArrangement;
  $('mastering-enabled').checked = true; $('target-lufs').value = -18; $('gentle-compression').checked = true;
  $('duration').value = 120;
  updateForm(); toast(t('stableApplied'));
});
$('generation-form').addEventListener('input', updateForm);
$('generation-form').addEventListener('change', updateForm);
$('generation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || polling.size || sessions.some(sessionIsOpen)) return;
  submitting = true; updateActivity();
  try {
    if (!online && !await health()) { $('connection-dialog').showModal(); return; }
    const input = formValues();
    input.title = input.title.trim() || t('untitled');
    if (input.generationMode !== 'single') {
      const session = await api('/api/sessions', { input, ...sessionOptions(input) });
      sessions.unshift(session); renderSessions();
      $('sessions-section').scrollIntoView({ block: 'nearest' });
      return;
    }
    const track = await api('/api/generate', input);
    tracks.unshift(track); render();
    startPolling(track.id);
  } catch (error) { toast(errorMessage(error), true); }
  finally { submitting = false; updateActivity(); }
});
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
  const preset = presets[button.dataset.preset];
  $('prompt').value = preset.prompt; $('bpm').value = preset.bpm;
  updateForm();
}));
document.querySelectorAll('[data-duration]').forEach(button => button.addEventListener('click', () => { $('duration').value = button.dataset.duration; updateForm(); }));
$('roll-seed').addEventListener('click', () => {
  $('random-seed').checked = false;
  $('seed').value = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647;
  updateForm();
});
$('generation-mode').addEventListener('change', () => {
  if ($('generation-mode').value !== 'single' && Number($('duration').value) === 60) $('duration').value = $('generation-mode').value === 'mix' ? 300 : 180;
  updateForm(); updateActivity();
});
$('connection-button').addEventListener('click', () => $('connection-dialog').showModal());
$('help-button').addEventListener('click', () => $('connection-dialog').showModal());
$('recheck').addEventListener('click', async () => {
  $('recheck').disabled = true;
  try { await health(); } finally { $('recheck').disabled = false; }
});
$('search').addEventListener('input', renderLibrary);
$('favorites-filter').addEventListener('click', () => {
  favoritesOnly = !favoritesOnly;
  $('favorites-filter').setAttribute('aria-pressed', String(favoritesOnly));
  renderLibrary();
});
window.addEventListener('hashchange', route);
function ambienceValues() {
  return { title: $('ambience-title').value, prompt: $('ambience-prompt').value, model: $('ambience-model').value,
    duration: Number($('ambience-duration').value), seed: Number($('ambience-seed').value), randomSeed: $('ambience-random').checked,
    background: { type: $('ambience-background').value, levelDb: Number($('ambience-volume').value) }, ending: { seconds: Number($('ambience-ending').value) },
    outputMode: $('ambience-output').value,
    album: { count: Number($('ambience-count').value), minSeconds: Number($('ambience-min').value), maxSeconds: Number($('ambience-max').value),
      loop: { enabled: $('ambience-loop').checked, minutes: Number($('ambience-loop-minutes').value), crossfadeSeconds: Number($('ambience-loop-fade').value) } } };
}
function renderAmbienceExamples() {
  const list = $('ambience-examples'); list.replaceChildren(node('span', '', t('startingPoint')));
  for (const [label, prompt] of ambiencePresets[$('ambience-model').value]) {
    list.append(action(t(label), () => { $('ambience-prompt').value = prompt; updateAmbienceForm(); }, 'preset'));
  }
}
function setAmbienceForm(input = {}) {
  $('ambience-output').value = input.outputMode || 'single';
  $('ambience-count').value = input.album?.count ?? 15;
  $('ambience-min').value = input.album?.minSeconds ?? 60;
  $('ambience-max').value = input.album?.maxSeconds ?? 120;
  $('ambience-loop').checked = input.album?.loop?.enabled ?? false;
  $('ambience-loop-minutes').value = input.album?.loop?.minutes ?? 120;
  $('ambience-loop-fade').value = input.album?.loop?.crossfadeSeconds ?? 2;
  $('ambience-model').value = input.model || (input.mode === 'sfx' ? 'small-sfx' : 'small-music');
  $('ambience-title').value = input.title || '';
  $('ambience-prompt').value = input.prompt ?? ambiencePresets[$('ambience-model').value][0][1];
  $('ambience-duration').value = input.duration ?? 30;
  $('ambience-seed').value = input.seed ?? 12345;
  $('ambience-random').checked = input.randomSeed ?? true;
  $('ambience-background').value = input.background?.type || 'off';
  $('ambience-volume').value = input.background?.levelDb ?? -32;
  const seconds = input.ending?.seconds ?? 0;
  if (![...$('ambience-ending').options].some(option => Number(option.value) === seconds)) {
    const option = node('option', '', seconds + ' s'); option.value = seconds; $('ambience-ending').append(option);
  }
  $('ambience-ending').value = seconds;
  renderAmbienceExamples(); updateAmbienceForm();
}
function updateAmbienceForm(busy = submitting || tracks.some(track => track.status === 'pending') || sessions.some(sessionIsOpen)) {
  const values = ambienceValues();
  const album = values.outputMode === 'album';
  $('ambience-album-options').hidden = !album;
  $('ambience-single-duration').hidden = album;
  $('ambience-duration').disabled = album;
  $('ambience-loop-options').hidden = !values.album.loop.enabled;
  for (const id of ['ambience-count', 'ambience-min', 'ambience-max', 'ambience-loop']) $(id).disabled = !album;
  for (const id of ['ambience-loop-minutes', 'ambience-loop-fade']) $(id).disabled = !album || !values.album.loop.enabled;
  let invalidAlbum = false;
  if (album) {
    try {
      const settings = ambienceAlbumSettings(values.album);
      $('ambience-album-preview').textContent = t('albumPreview', { count: settings.count, min: settings.minSeconds, max: settings.maxSeconds });
    } catch (error) { invalidAlbum = true; $('ambience-album-preview').textContent = errorMessage(error); }
  }
  $('ambience-seed').disabled = values.randomSeed;
  $('ambience-volume').disabled = values.background.type === 'off';
  $('ambience-volume-display').textContent = values.background.levelDb + ' dB';
  $('ambience-mode-hint').textContent = t(values.model === 'small-music' ? 'ambienceMusicHint' : 'ambienceSfxHint');
  $('ambience-engine-status').textContent = t(!ambienceEngine.checked ? 'ambienceChecking' : !ambienceEngine.installed ? 'errorAmbienceInstall' : !ambienceEngine.validated ? 'errorAmbienceValidation' : 'ambienceReady');
  const needsFfmpeg = hasBackground(values.background) || hasEnding(values.ending) || (album && values.album.loop.enabled);
  $('ambience-generate').disabled = busy || invalidAlbum || !ambienceEngine.installed || !ambienceEngine.validated || (needsFfmpeg && !canMix);
  $('ambience-generate').textContent = t(busy ? 'generating' : album ? 'albumGenerate' : 'ambienceGenerate');
  const pending = tracks.find(track => track.input.engine === 'stable-audio-3' && track.status === 'pending');
  $('ambience-activity').hidden = !pending && !submitting;
  $('ambience-activity-title').textContent = pending?.input.title || t('sending');
  $('ambience-activity-detail').textContent = t('ambiencePhase_' + (pending?.phase || 'loading'));
  try { localStorage.setItem('afterboot-ambience-draft-v1', JSON.stringify(values)); } catch {}
}
async function checkAmbienceEngine() {
  try { ambienceEngine = { ...await api('/api/ambiences/status'), checked: true }; }
  catch (error) { ambienceEngine = { checked: true }; toast(errorMessage(error), true); }
  updateAmbienceForm();
}
$('ambience-form').addEventListener('input', () => updateAmbienceForm());
$('ambience-form').addEventListener('change', () => updateAmbienceForm());
$('ambience-model').addEventListener('change', renderAmbienceExamples);
$('ambience-recheck').addEventListener('click', checkAmbienceEngine);
$('ambience-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting || tracks.some(track => track.status === 'pending') || sessions.some(sessionIsOpen)) return;
  submitting = true; updateActivity();
  try {
    const input = ambienceValues(); input.title = input.title.trim() || t('ambiences');
    if (input.outputMode === 'album') {
      const session = await api('/api/ambiences/albums', { input, album: input.album });
      sessions.unshift(session); renderSessions();
      $('ambience-albums-section').scrollIntoView({ block: 'nearest' }); return;
    }
    const track = await api('/api/ambiences/generate', input);
    tracks.unshift(track); render(); startPolling(track.id);
  } catch (error) { toast(errorMessage(error), true); }
  finally { submitting = false; updateActivity(); }
});
function translateTree(root) {
  root.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(element => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-aria]').forEach(element => { element.setAttribute('aria-label', t(element.dataset.i18nAria)); });
}
function applyLanguage() {
  document.documentElement.lang = language;
  $('language').value = language;
  translateTree(document);
  translateTree($('empty-template').content);
  updateForm();
  route();
  renderConnection();
  render();
  renderSessions();
  renderAmbienceExamples();
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}
$('language').addEventListener('change', () => {
  language = $('language').value;
  try { localStorage.setItem('afterboot-language-v1', language); } catch {}
  applyLanguage();
});
let draft;
let ambienceDraft;
try { ambienceDraft = JSON.parse(localStorage.getItem('afterboot-ambience-draft-v1')); } catch {}
setAmbienceForm(ambienceDraft || {});
try { draft = JSON.parse(localStorage.getItem('afterboot-draft-v1')); } catch {}
setForm(draft || { prompt: presets.jungle.prompt });
applyLanguage();
health();
checkAmbienceEngine();
try {
  tracks = await api('/api/tracks');
  render();
  tracks.filter(track => track.status === 'pending' && !track.sessionId).forEach(track => startPolling(track.id));
} catch (error) { toast(t('libraryLoadError', { message: errorMessage(error) }), true); }
try { await refreshSessions(); } catch (error) { toast(errorMessage(error), true); }
setInterval(() => { refreshSessions().catch(() => {}); }, 3000);
setInterval(health, 30000);
setInterval(updateActivity, 1000);
