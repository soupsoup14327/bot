/** @type {Map<string, string[]>} */
const pastTrackUrlsByGuild = new Map();
/** @type {Map<string, string[]>} */
const sessionPlayedWatchUrlsByGuild = new Map();
/** @type {Set<string>} */
const suppressHistoryPushByGuild = new Set();
/** @type {Set<string>} */
const suppressTrackFinishedOnceByGuild = new Set();
/** @type {Map<string, string>} */
const idleBackForwardTailByGuild = new Map();
/** @type {Map<string, number>} */
const idleNavCursorByGuild = new Map();

export function getPastTrackUrls(guildId) {
  return pastTrackUrlsByGuild.get(String(guildId)) ?? [];
}

export function setPastTrackUrls(guildId, urls) {
  pastTrackUrlsByGuild.set(String(guildId), urls);
}

export function persistPastTrackUrls(guildId, urls) {
  const id = String(guildId);
  if (!Array.isArray(urls) || urls.length === 0) {
    pastTrackUrlsByGuild.delete(id);
    return;
  }
  pastTrackUrlsByGuild.set(id, urls);
}

export function deletePastTrackUrls(guildId) {
  pastTrackUrlsByGuild.delete(String(guildId));
}

export function getSessionPlayedWatchUrls(guildId) {
  return sessionPlayedWatchUrlsByGuild.get(String(guildId)) ?? [];
}

export function setSessionPlayedWatchUrls(guildId, urls) {
  sessionPlayedWatchUrlsByGuild.set(String(guildId), urls);
}

export function deleteSessionPlayedWatchUrls(guildId) {
  sessionPlayedWatchUrlsByGuild.delete(String(guildId));
}

export function markSuppressHistoryPush(guildId) {
  suppressHistoryPushByGuild.add(String(guildId));
}

export function consumeSuppressHistoryPush(guildId) {
  const id = String(guildId);
  const had = suppressHistoryPushByGuild.has(id);
  if (had) suppressHistoryPushByGuild.delete(id);
  return had;
}

export function markSuppressTrackFinishedOnce(guildId) {
  suppressTrackFinishedOnceByGuild.add(String(guildId));
}

export function consumeSuppressTrackFinishedOnce(guildId) {
  return suppressTrackFinishedOnceByGuild.delete(String(guildId));
}

export function getIdleBackForwardTail(guildId) {
  return idleBackForwardTailByGuild.get(String(guildId));
}

export function setIdleBackForwardTail(guildId, url) {
  idleBackForwardTailByGuild.set(String(guildId), url);
}

export function deleteIdleBackForwardTail(guildId) {
  idleBackForwardTailByGuild.delete(String(guildId));
}

export function hasIdleBackForwardTail(guildId) {
  return idleBackForwardTailByGuild.has(String(guildId));
}

export function getIdleNavCursor(guildId) {
  return idleNavCursorByGuild.get(String(guildId));
}

export function setIdleNavCursor(guildId, cursor) {
  idleNavCursorByGuild.set(String(guildId), cursor);
}

export function deleteIdleNavCursor(guildId) {
  idleNavCursorByGuild.delete(String(guildId));
}

export function clearIdleNavigationState(guildId) {
  const id = String(guildId);
  idleNavCursorByGuild.delete(id);
  idleBackForwardTailByGuild.delete(id);
  pastTrackUrlsByGuild.delete(id);
  sessionPlayedWatchUrlsByGuild.delete(id);
  suppressHistoryPushByGuild.delete(id);
  suppressTrackFinishedOnceByGuild.delete(id);
}
