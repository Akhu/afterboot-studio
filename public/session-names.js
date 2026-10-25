const trackNumber = (index, total) => String(index + 1).padStart(Math.max(2, String(total || index + 1).length), '0');

export function sessionTrackTitle(title, index, total) {
  const base = Array.from(String(title || 'Afterboot session').trim()).slice(0, 85).join('');
  return base + ' - ' + trackNumber(index, total);
}

export function safeFileStem(title) {
  let value = String(title || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  if (!value) value = 'Afterboot session';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = 'Afterboot - ' + value;
  const encoder = new TextEncoder();
  let result = '', bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (bytes + size > 180) break;
    bytes += size; result += character;
  }
  return result.replace(/[. ]+$/g, '');
}

export function sessionTrackFilename(title, index, total) {
  return safeFileStem(title) + ' - ' + trackNumber(index, total) + '.mp3';
}

export function completedSessionTracks(session, tracks) {
  const byId = new Map(tracks.map(track => [track.id, track]));
  const byIndex = new Map();
  const limit = session.nextIndex ?? (session.status === 'complete' ? session.plan.durations.length : 0);
  for (const id of session.trackIds) {
    const track = byId.get(id);
    if (track?.status === 'ready' && Number.isInteger(track.sessionIndex) && track.sessionIndex >= 0 && track.sessionIndex < limit) byIndex.set(track.sessionIndex, track);
  }
  return [...byIndex.values()].sort((a, b) => a.sessionIndex - b.sessionIndex);
}
