/** @type {Map<string, Map<string, number>>} */
const escapeMetricsByGuild = new Map();

function gid(guildId) {
  return String(guildId);
}

function ensureGuildMetrics(guildId) {
  const id = gid(guildId);
  let metrics = escapeMetricsByGuild.get(id);
  if (!metrics) {
    metrics = new Map();
    escapeMetricsByGuild.set(id, metrics);
  }
  return metrics;
}

export function incrementAutoplayEscapeMetric(guildId, name, delta = 1) {
  const key = String(name ?? '').trim();
  if (!key) return 0;
  const inc = Number(delta);
  if (!Number.isFinite(inc) || inc === 0) {
    return ensureGuildMetrics(guildId).get(key) ?? 0;
  }
  const metrics = ensureGuildMetrics(guildId);
  const next = (metrics.get(key) ?? 0) + inc;
  metrics.set(key, next);
  return next;
}

export function recordAutoplayEscapeTransitionMetric(guildId, stage, meta = null) {
  const stageKey = String(stage ?? '').trim();
  if (!stageKey) return;
  incrementAutoplayEscapeMetric(guildId, `transition.${stageKey}`);

  if (stageKey === 'killed') {
    const reason =
      meta && typeof meta.reason === 'string' && meta.reason.trim()
        ? meta.reason.trim()
        : null;
    if (reason) {
      incrementAutoplayEscapeMetric(guildId, `killed.${reason}`);
    }
  }
}

export function getAutoplayEscapeMetrics(guildId = undefined) {
  if (guildId == null) {
    return Object.fromEntries(
      [...escapeMetricsByGuild.entries()].map(([id, metrics]) => [
        id,
        Object.fromEntries(metrics.entries()),
      ]),
    );
  }
  return Object.fromEntries(
    [...(escapeMetricsByGuild.get(gid(guildId)) ?? new Map()).entries()],
  );
}

export function clearAutoplayEscapeMetrics(guildId = undefined) {
  if (guildId == null) {
    escapeMetricsByGuild.clear();
    return;
  }
  escapeMetricsByGuild.delete(gid(guildId));
}
