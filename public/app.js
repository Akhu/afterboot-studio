import { translate, preferredLanguage } from '/i18n.js';

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
async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
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
    online = true;
  } catch {
    online = false;
  }
  connectionChecked = true;
  renderConnection();
  return online;
}
function formValues() {
  return {
    title: $('track-title').value, prompt: $('prompt').value,
    bpm: Number($('bpm').value), duration: Number($('duration').value),
    randomSeed: $('random-seed').checked, seed: Number($('seed').value),
    thinking: $('thinking').checked, format: $('format').value,
  };
}
function updateForm() {
  $('prompt-count').textContent = t('characters', { count: $('prompt').value.length });
  $('seed').disabled = $('random-seed').checked;
  const duration = Number($('duration').value);
  $('duration-display').textContent = Math.floor(duration / 60) + ' min ' + String(duration % 60).padStart(2, '0');
  document.querySelectorAll('[data-duration]').forEach(button => button.classList.toggle('selected', Number(button.dataset.duration) === duration));
  document.querySelectorAll('[data-preset]').forEach(button => button.classList.toggle('active', $('prompt').value === presets[button.dataset.preset].prompt));
  try { localStorage.setItem('afterboot-draft-v1', JSON.stringify(formValues())); } catch {}
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
  updateForm();
}
function seedOf(track) { return String(track.returnedSeed ?? track.input.seed); }
function restore(track, variation) {
  const returnedSeed = Number(seedOf(track).split(',')[0]);
  setForm({
    ...track.input, title: track.input.title + (variation ? t('variationSuffix') : ''),
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
function audioCard(track) {
  const card = node('article', 'track');
  card.dataset.trackId = track.id;
  const heading = node('div', 'track-heading');
  heading.append(node('span', 'track-disc', '◎'));
  const info = node('div', 'track-info');
  info.append(node('h3', '', track.input.title));
  const meta = node('div', 'track-meta');
  meta.append(node('span', '', track.input.bpm + ' BPM'), node('span', '', track.input.duration + ' s'));
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
  favorite.setAttribute('aria-label', t('favoriteTrack', { title: track.input.title }));
  favorite.setAttribute('aria-pressed', String(track.favorite));
  heading.append(info, favorite); card.append(heading);
  if (track.status === 'ready') {
    const audio = node('audio');
    audio.controls = true; audio.preload = 'metadata'; audio.src = track.audioURL;
    audio.addEventListener('play', () => document.querySelectorAll('audio').forEach(other => { if (other !== audio) other.pause(); }));
    audio.addEventListener('error', () => toast(t('playbackError'), true));
    card.append(audio);
  } else {
    card.append(node('p', track.status === 'failed' ? 'track-error' : 'pending-message', track.status === 'failed' ? trackError(track) : t('waitingResult')));
  }
  const buttons = node('div', 'track-actions');
  if (track.status === 'ready') {
    const download = node('a', 'download', t('downloadAudio', { format: track.input.format.toUpperCase() }));
    download.href = track.audioURL + '?download'; download.setAttribute('download', '');
    buttons.append(download);
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
  details.append(node('code', '', track.input.model + ' · ' + t(track.input.thinking ? 'planningOn' : 'planningOff') + ' · ' + t('seedRequested', { seed: track.input.seed })));
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
  const visible = tracks.filter(track => (!favoritesOnly || track.favorite) && (track.input.title + ' ' + track.input.prompt + ' ' + seedOf(track)).toLowerCase().includes(term));
  fillList('library-tracks', visible, tracks.length && !visible.length ? t('noMatches') : '');
  $('library-count').textContent = t(visible.length === 1 ? 'trackCountOne' : 'trackCountMany', { count: visible.length });
}
function render() {
  $('nav-count').textContent = tracks.length;
  fillList('recent-tracks', tracks.slice(0, 3));
  renderLibrary();
  updateActivity();
}
function updateActivity() {
  const pending = tracks.find(track => polling.has(track.id));
  const busy = submitting || Boolean(pending);
  $('generate').disabled = busy;
  if (busy) $('generate').textContent = t(submitting ? 'sending' : 'generating');
  else {
    const icon = node('span', '', '▶');
    icon.setAttribute('aria-hidden', 'true');
    $('generate').replaceChildren(icon, document.createTextNode(' ' + t('generate')));
  }
  $('activity').hidden = !busy;
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
  const selected = location.hash === '#library' ? 'library' : 'create';
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== selected; });
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.classList.toggle('active', link.dataset.nav === selected);
    if (link.dataset.nav === selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('breadcrumb').textContent = t(selected === 'library' ? 'breadcrumbLibrary' : 'breadcrumbCreate');
  $('window-document').textContent = t(selected === 'library' ? 'windowLibrary' : 'windowCreate');
  document.querySelectorAll('audio').forEach(audio => { if (audio.closest('.view').hidden) audio.pause(); });
}
$('generation-form').addEventListener('input', updateForm);
$('generation-form').addEventListener('change', updateForm);
$('generation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || polling.size) return;
  submitting = true; updateActivity();
  try {
    if (!online && !await health()) { $('connection-dialog').showModal(); return; }
    const input = formValues();
    input.title = input.title.trim() || t('untitled');
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
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}
$('language').addEventListener('change', () => {
  language = $('language').value;
  try { localStorage.setItem('afterboot-language-v1', language); } catch {}
  applyLanguage();
});
let draft;
try { draft = JSON.parse(localStorage.getItem('afterboot-draft-v1')); } catch {}
setForm(draft || { prompt: presets.jungle.prompt });
applyLanguage();
health();
try {
  tracks = await api('/api/tracks');
  render();
  tracks.filter(track => track.status === 'pending').forEach(track => startPolling(track.id));
} catch (error) { toast(t('libraryLoadError', { message: errorMessage(error) }), true); }
setInterval(health, 30000);
setInterval(updateActivity, 1000);
