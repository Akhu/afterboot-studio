import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const terminal = new Set(['complete', 'stopped']);
function fail(code, status = 409) { throw Object.assign(new Error(code), { code, status }); }

export function createSessionManager({ dataDir, listTracks, submitTrack, syncTrack, assemble, canMix, pollMs = 3000 }) {
  const path = join(dataDir, 'sessions.json');
  const sessions = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  if (!Array.isArray(sessions)) throw new Error('Invalid sessions.json. File preserved.');
  let working = false, closed = false;
  const controller = new AbortController();
  function save() {
    writeFileSync(path + '.tmp', JSON.stringify(sessions, null, 2));
    renameSync(path + '.tmp', path);
  }
  for (const session of sessions) {
    if (!terminal.has(session.status)) {
      const recovered = listTracks().find(track => track.sessionId === session.id && track.sessionIndex === session.nextIndex && track.status !== 'failed');
      if (recovered) {
        session.currentTrackId = recovered.id; session.submissionUnknown = false;
        if (!session.trackIds.includes(recovered.id)) session.trackIds.push(recovered.id);
      }
      session.status = 'paused';
      session.errorCode = session.submissionUnknown ? 'errorSessionSubmission' : 'sessionRestarted';
    }
  }
  if (sessions.length) save();
  const busy = () => sessions.some(session => !terminal.has(session.status));
  function publicSession(session) {
    const ready = session.trackIds.map(id => listTracks().find(track => track.id === id)).filter(track => track?.status === 'ready');
    return { ...session, audioFile: undefined, completedCount: ready.length, audioURL: session.audioFile ? '/api/sessions/' + session.id + '/audio' : null };
  }
  async function tick() {
    if (closed || working) return;
    const session = sessions.find(item => ['running', 'pausing', 'stopping'].includes(item.status));
    if (!session) return;
    working = true;
    try {
      if (session.currentTrackId) {
        const track = listTracks().find(item => item.id === session.currentTrackId);
        if (!track) fail('errorTrackNotFound');
        await syncTrack(track);
        if (closed) return;
        if (track.status === 'pending') return;
        if (track.status === 'failed') fail('errorSessionTrack');
        session.currentTrackId = null;
        session.nextIndex += 1;
        save();
      }
      if (session.status === 'pausing' || session.status === 'stopping') {
        session.status = session.status === 'pausing' ? 'paused' : 'stopped';
        save(); return;
      }
      if (session.nextIndex === session.plan.durations.length) {
        if (session.plan.mode === 'mix') {
          session.status = 'assembling'; save();
          const ready = session.trackIds.map(id => listTracks().find(track => track.id === id)).filter(track => track?.status === 'ready');
          const output = await assemble(session, ready, dataDir, controller.signal);
          if (closed) return;
          Object.assign(session, output);
        }
        session.status = 'complete';
        session.completedAt = new Date().toISOString();
        save(); return;
      }
      const index = session.nextIndex;
      const input = { ...session.input, duration: session.plan.durations[index], seed: (session.input.seed + index) % 2147483648, title: session.input.title.slice(0, 85) + ' · ' + String(index + 1).padStart(2, '0') };
      // Persist before sending. An uncertain submission must never be retried automatically.
      session.submissionUnknown = true; save();
      const track = await submitTrack(input, { sessionId: session.id, sessionIndex: index });
      session.currentTrackId = track.id;
      session.trackIds.push(track.id);
      session.submissionUnknown = false;
      save();
    } catch (error) {
      if (closed) return;
      if (session.submissionUnknown) {
        const accepted = listTracks().find(track => track.sessionId === session.id && track.sessionIndex === session.nextIndex && track.status !== 'failed');
        if (accepted) {
          session.currentTrackId = accepted.id;
          if (!session.trackIds.includes(accepted.id)) session.trackIds.push(accepted.id);
          session.submissionUnknown = false;
        } else if (['errorEngine', 'errorEngineHttp'].includes(error.code)) session.submissionUnknown = false;
      }
      session.status = 'paused';
      session.errorCode = session.submissionUnknown ? 'errorSessionSubmission' : error.code || 'errorSessionMix';
      session.errorParams = error.params || {};
      save();
    } finally { working = false; }
  }
  function schedule() { tick().catch(error => console.error('Could not persist session progress:', error)); }
  const timer = setInterval(schedule, pollMs);
  timer.unref();
  return {
    busy,
    list: () => sessions.map(publicSession),
    get: id => sessions.find(session => session.id === id),
    start(input, plan) {
      if (closed || busy() || listTracks().some(track => track.status === 'pending')) fail('errorSessionBusy');
      if (plan.mode === 'mix' && !canMix) fail('errorFfmpeg', 400);
      const session = { id: randomUUID(), input, plan, status: 'running', nextIndex: 0, trackIds: [], currentTrackId: null, createdAt: new Date().toISOString(), submissionUnknown: false };
      sessions.unshift(session); save();
      schedule();
      return publicSession(session);
    },
    control(id, action) {
      const session = sessions.find(item => item.id === id);
      if (!session) fail('errorSessionNotFound', 404);
      if (terminal.has(session.status) || session.status === 'assembling') fail('errorSessionControl');
      if (action === 'resume' && session.status === 'paused') {
        if (working) fail('errorSessionControl');
        if (session.submissionUnknown) fail('errorSessionSubmission');
        const track = listTracks().find(item => item.id === session.currentTrackId);
        if (track?.status === 'failed') session.currentTrackId = null;
        session.status = 'running';
        delete session.errorCode; delete session.errorParams;
      } else if (action === 'pause' && session.status === 'running') session.status = 'pausing';
      else if (action === 'stop') {
        const track = listTracks().find(item => item.id === session.currentTrackId);
        session.status = track?.status === 'pending' || working ? 'stopping' : 'stopped';
      } else fail('errorSessionControl');
      save(); schedule();
      return publicSession(session);
    },
    close() {
      closed = true; clearInterval(timer); controller.abort();
      for (const session of sessions) {
        if (['running', 'pausing', 'stopping', 'assembling'].includes(session.status)) {
          session.status = 'paused'; session.errorCode = 'sessionRestarted';
        }
      }
      if (sessions.length) save();
    },
  };
}
