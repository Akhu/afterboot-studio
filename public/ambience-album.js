function fail() { throw Object.assign(new Error('errorAmbienceAlbum'), { code: 'errorAmbienceAlbum', status: 400 }); }

export function ambienceAlbumSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const { count = 15, minSeconds = 60, maxSeconds = 120, loop = {} } = value;
  if (![count, minSeconds, maxSeconds].every(Number.isInteger) || count < 1 || count > 100 || minSeconds < 5 || maxSeconds > 120 || minSeconds > maxSeconds) fail();
  if (!loop || typeof loop !== 'object' || Array.isArray(loop)) fail();
  const { enabled = false, minutes = 120, crossfadeSeconds = 2 } = loop;
  if (typeof enabled !== 'boolean' || !Number.isInteger(minutes) || minutes < 1 || minutes > 240 || !Number.isInteger(crossfadeSeconds) || crossfadeSeconds < 0 || crossfadeSeconds > 12 || (enabled && crossfadeSeconds * 2 >= minSeconds)) fail();
  return { count, minSeconds, maxSeconds, loop: { enabled, minutes, crossfadeSeconds } };
}

// A saved seed fixes the complete playback order, including assembly retries.
export function albumRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function albumLoopOrder(durations, targetSeconds, fade, seed) {
  const random = albumRandom(seed);
  const order = [], cycles = [];
  let seconds = 0, previousCycle;
  while (seconds < targetSeconds) {
    const cycle = durations.map((_, index) => index);
    for (let index = cycle.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [cycle[index], cycle[other]] = [cycle[other], cycle[index]];
    }
    if (previousCycle && cycle.every((value, index) => value === previousCycle[index]) && cycle.length > 1) cycle.push(cycle.shift());
    if (cycle.length > 2 && cycle[0] === order.at(-1)) {
      // Keep the new cycle different and avoid repeating the boundary track.
      [cycle[0], cycle[1]] = [cycle[1], cycle[0]];
      if (cycle.every((value, index) => value === previousCycle[index])) [cycle[1], cycle[2]] = [cycle[2], cycle[1]];
    }
    cycles.push([...cycle]); previousCycle = cycle;
    for (const index of cycle) {
      seconds += durations[index] - (order.length ? fade : 0);
      order.push(index);
      if (seconds >= targetSeconds) break;
    }
  }
  return { order, cycles };
}

export function ambienceAlbumPlan(value, seed) {
  const album = ambienceAlbumSettings(value), random = albumRandom(seed);
  const durations = Array.from({ length: album.count }, () => album.minSeconds + Math.floor(random() * (album.maxSeconds - album.minSeconds + 1)));
  const loop = { ...album.loop, ...(album.loop.enabled ? albumLoopOrder(durations, album.loop.minutes * 60, album.loop.crossfadeSeconds, seed ^ 0xa1b2c3d4) : {}) };
  return { kind: 'ambience-album', mode: 'tracks', album, durations, targetSeconds: durations.reduce((a, b) => a + b, 0), crossfadeSeconds: 0, loop };
}
