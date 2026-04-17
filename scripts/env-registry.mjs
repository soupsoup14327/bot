export const INTERNAL_ENV_KEYS = new Set(['FFMPEG_PATH']);

/**
 * Central source of truth for runtime env vars.
 * Used by docs and verify scripts.
 */
export const ENV_REGISTRY = [
  // Core Discord
  { name: 'DISCORD_TOKEN', category: 'core', type: 'string', required: true, secret: true, description: 'Discord bot token.' },
  { name: 'DISCORD_CLIENT_ID', category: 'core', type: 'string', required: false, description: 'Application ID for slash command registration.' },
  { name: 'DISCORD_GUILD_ID', category: 'core', type: 'string', required: false, description: 'Guild id or comma-separated guild ids for fast command sync.' },
  { name: 'DISCORD_KEEP_GLOBAL_COMMANDS', category: 'core', type: 'bool01', defaultValue: '0', required: false, description: 'Keep global slash commands when guild-scoped registration is enabled.' },
  { name: 'OLLAMA_URL', category: 'core', type: 'url', required: false, description: 'Ollama HTTP API base URL (legacy template bot).' },
  { name: 'OLLAMA_MODEL', category: 'core', type: 'string', required: false, description: 'Ollama model name (legacy template bot).' },

  // Metrics and observability
  { name: 'METRICS_TXT_ENABLED', category: 'metrics', type: 'bool01', defaultValue: '1', required: false, description: 'Enable metrics writes to data/metrics/*.txt.' },
  { name: 'AUTOPLAY_DEBUG', category: 'metrics', type: 'bool01', defaultValue: '0', required: false, description: 'Verbose autoplay trace logs.' },
  { name: 'AUTOPLAY_BASELINE_LOG', category: 'metrics', type: 'bool01', defaultValue: '0', required: false, description: 'Emit baseline autoplay telemetry events.' },
  { name: 'DEBUG_PLAYBACK', category: 'metrics', type: 'bool01', defaultValue: '0', required: false, description: 'Verbose playback scheduler debug logs.' },

  // Groq
  { name: 'GROQ_API_KEY', category: 'groq', type: 'string', required: false, secret: true, description: 'Groq API key for chat and autoplay generation.' },
  { name: 'GROQ_MODEL', category: 'groq', type: 'string', defaultValue: 'llama-3.1-8b-instant', required: false, description: 'Model for autoplay generation tasks.' },
  { name: 'GROQ_CHAT_MODEL', category: 'groq', type: 'string', defaultValue: 'llama-3.3-70b-versatile', required: false, description: 'Model for /chat.' },
  { name: 'GROQ_TIMEOUT_MS', category: 'groq', type: 'int', min: 1000, max: 120000, defaultValue: '8000', required: false, description: 'Request timeout for Groq API calls.' },
  { name: 'GROQ_AUTOPLAY_TEMPERATURE', category: 'groq', type: 'float', min: 0, max: 2, defaultValue: '0.55', required: false, description: 'Sampling temperature for autoplay prompting.' },
  { name: 'GROQ_AUTOPLAY_NEGATIVE_CONTEXT', category: 'groq', type: 'bool01', defaultValue: '1', required: false, description: 'Use negative context in autoplay prompting.' },
  { name: 'GROQ_AUTOPLAY_NEGATIVE_LIMIT', category: 'groq', type: 'int', min: 0, max: 20, defaultValue: '4', required: false, description: 'Max number of negative context tokens for autoplay.' },

  // Autoplay behavior and strategy
  { name: 'AUTOPLAY_CANDIDATES_PER_QUERY', category: 'autoplay', type: 'int', min: 4, max: 12, defaultValue: '8', required: false, description: 'How many YouTube candidates are retrieved per query.' },
  { name: 'AUTOPLAY_PLAYABILITY_CACHE_SHADOW', category: 'autoplay', type: 'bool01', defaultValue: '0', required: false, description: 'Collect playability cache without hard blocking candidates.' },
  { name: 'AUTOPLAY_PLAYABILITY_HARD_SKIP_ENABLED', category: 'autoplay', type: 'bool01', defaultValue: '0', required: false, description: 'Skip candidates known as unplayable.' },
  { name: 'AUTOPLAY_PLAYABILITY_CACHE_TTL_MS', category: 'autoplay', type: 'int', min: 60000, max: 2592000000, defaultValue: '604800000', required: false, description: 'TTL for unplayable URL cache entries.' },
  { name: 'AUTOPLAY_FAST_LANE_ENABLED', category: 'autoplay', type: 'bool01', defaultValue: '0', required: false, description: 'Enable reduced-Groq retrieval path when scenario is stable.' },
  { name: 'AUTOPLAY_FAST_LANE_QUERY_BUDGET', category: 'autoplay', type: 'int', min: 1, max: 20, defaultValue: '6', required: false, description: 'Query budget for fast-lane retrieval.' },
  { name: 'AUTOPLAY_STALE_GUARD_ENABLED', category: 'autoplay', type: 'bool01', defaultValue: '1', required: false, description: 'Drop stale in-flight autoplay generations by generation id.' },
  { name: 'AUTOPLAY_RECOVERY_GROQ_ONLY', category: 'autoplay', type: 'bool01', defaultValue: '0', required: false, description: 'Limit Groq use to recovery mode after bad spawn streak.' },
  { name: 'AUTOPLAY_RECOVERY_STREAK_MIN', category: 'autoplay', type: 'int', min: 1, max: 10, defaultValue: '2', required: false, description: 'Bad spawn streak threshold to enter recovery mode.' },
  { name: 'AUTOPLAY_ALT_VARIANTS_RELAXED', category: 'autoplay', type: 'bool01', defaultValue: '0', required: false, description: 'Relax alt-version filtering for better recall.' },
  { name: 'AUTOPLAY_ALT_STREAK_MIN', category: 'autoplay', type: 'int', min: 1, max: 10, defaultValue: '2', required: false, description: 'Consecutive alt-version threshold before penalty.' },
  { name: 'AUTOPLAY_ALT_STREAK_PENALTY', category: 'autoplay', type: 'int', min: 0, max: 200, defaultValue: '38', required: false, description: 'Penalty applied for sustained alt-version streaks.' },
  { name: 'AUTOPLAY_VARIETY_CONTROLLER_ENABLED', category: 'autoplay', type: 'bool01', defaultValue: '0', required: false, description: 'Enable anti-repeat variety controller.' },
  { name: 'AUTOPLAY_VARIETY_BUDGET_EXPERIMENTAL', category: 'autoplay', type: 'bool01', defaultValue: '0', required: false, description: 'Enable experimental 70/30 query budget split.' },
  { name: 'AUTOPLAY_VARIETY_ARTIST_SOFT_PENALTY', category: 'autoplay', type: 'float', min: 0, max: 80, defaultValue: '12', required: false, description: 'Soft score penalty for repeating artists.' },
  { name: 'AUTOPLAY_VARIETY_ARTIST_STRONG_PENALTY', category: 'autoplay', type: 'float', min: 0, max: 120, defaultValue: '32', required: false, description: 'Strong score penalty for repeating artists.' },
  { name: 'AUTOPLAY_VARIETY_FAMILY_STREAK_BASE', category: 'autoplay', type: 'float', min: 0, max: 40, defaultValue: '8', required: false, description: 'Base penalty for repetitive query family streaks.' },
  { name: 'AUTOPLAY_VARIETY_FAMILY_STREAK_MULT', category: 'autoplay', type: 'float', min: 1, max: 2, defaultValue: '1.35', required: false, description: 'Multiplier for repetitive query family streak penalty.' },
  { name: 'AUTOPLAY_RANKER_SEARCH_WEIGHT', category: 'autoplay', type: 'float', min: 0, max: 3, defaultValue: '1', required: false, description: 'Weight of search score in candidate ranker.' },
  { name: 'AUTOPLAY_RANKER_SIGNAL_WEIGHT', category: 'autoplay', type: 'float', min: 0, max: 2, defaultValue: '0.35', required: false, description: 'Weight of local signal boost in ranker.' },
  { name: 'AUTOPLAY_RANKER_EXACT_PAIR_WEIGHT', category: 'autoplay', type: 'float', min: 0, max: 2, defaultValue: '1', required: false, description: 'Weight for exact pair match bonus.' },
  { name: 'AUTOPLAY_RANKER_ANCHOR_MISS_WEIGHT', category: 'autoplay', type: 'float', min: 0, max: 2, defaultValue: '1', required: false, description: 'Weight for identity-anchor miss penalty.' },
  { name: 'AUTOPLAY_RANKER_FALLBACK_PENALTY', category: 'autoplay', type: 'float', min: 0, max: 40, defaultValue: '8', required: false, description: 'Penalty for fallback candidates in ranker.' },
  { name: 'AUTOPLAY_ARTIST_COOLDOWN_ENABLED', category: 'autoplay', type: 'bool01', defaultValue: '0', required: false, description: 'Enable artist cooldown telemetry hints.' },
  { name: 'AUTOPLAY_ARTIST_COOLDOWN_WINDOW', category: 'autoplay', type: 'int', min: 1, max: 100, defaultValue: '8', required: false, description: 'Artist cooldown lookback window size.' },
  { name: 'AUTOPLAY_POLICY_ENABLED', category: 'autoplay', type: 'bool01', defaultValue: '1', required: false, description: 'Enable autoplay query policy and anti-loop controls.' },
  { name: 'AUTOPLAY_TOKEN_LOOP_MIN', category: 'autoplay', type: 'int', min: 1, max: 20, defaultValue: '3', required: false, description: 'Loop threshold for repeated query token mitigation.' },
  { name: 'AUTOPLAY_STRONG_AVOID_MIN', category: 'autoplay', type: 'int', min: 1, max: 20, defaultValue: '2', required: false, description: 'Threshold for strong avoid list application.' },
  { name: 'AUTOPLAY_QUERY_QUARANTINE_WINDOW', category: 'autoplay', type: 'int', min: 1, max: 100, defaultValue: '8', required: false, description: 'Window length for query quarantine logic.' },
  { name: 'AUTOPLAY_QUERY_FAMILY_MAX_STREAK', category: 'autoplay', type: 'int', min: 1, max: 20, defaultValue: '3', required: false, description: 'Max same-family query streak before diversification.' },

  // Playback and stream
  { name: 'VOICE_EMPTY_LEAVE_MINUTES', category: 'playback', type: 'float', min: 0, max: 120, defaultValue: '1', required: false, description: 'Minutes before leaving voice when channel is empty.' },
  { name: 'AUDIO_NORMALIZE', category: 'playback', type: 'bool01', defaultValue: '1', required: false, description: 'Enable ffmpeg normalize filter for track playback.' },
  { name: 'AUDIO_FFMPEG_AF', category: 'playback', type: 'string', required: false, description: 'Custom ffmpeg -af filter string (overrides default normalize filter).' },
  { name: 'YT_DLP_AUTO_UPDATE', category: 'playback', type: 'bool01', defaultValue: '1', required: false, description: 'Enable periodic youtube-dl-exec updater.' },
  { name: 'YT_DLP_UPDATE_INTERVAL_HOURS', category: 'playback', type: 'float', min: 1, max: 168, defaultValue: '24', required: false, description: 'Update interval for yt-dlp in hours.' },
  { name: 'YT_DLP_UPDATE_DELAY_MS', category: 'playback', type: 'int', min: 0, max: 3600000, defaultValue: '8000', required: false, description: 'Initial delay before first yt-dlp update check.' },

  // Signals and recommendation bridge
  { name: 'MUSIC_SIGNALS_ENABLED', category: 'signals', type: 'bool01', defaultValue: '1', required: false, description: 'Enable in-memory track events signal bus.' },
  { name: 'MUSIC_SIGNALS_BUFFER', category: 'signals', type: 'int', min: 10, max: 1000, defaultValue: '100', required: false, description: 'Per-guild ring buffer size for signals.' },
  { name: 'MUSIC_SIGNALS_MAX_AGE_H', category: 'signals', type: 'float', min: 1, max: 720, defaultValue: '24', required: false, description: 'Retention period for persisted signals in hours.' },
  { name: 'MUSIC_QUICK_SKIP_MS', category: 'signals', type: 'int', min: 1000, max: 600000, defaultValue: '5000', required: false, description: 'Threshold for quick skip classification and boost logic.' },
  { name: 'MUSIC_BRIDGE_ENABLED', category: 'signals', type: 'bool01', defaultValue: '1', required: false, description: 'Enable recommendation bridge (local boost + optional server).' },
  { name: 'MUSIC_SIGNALS_ENDPOINT', category: 'signals', type: 'url', required: false, description: 'Recommendation bridge sync endpoint URL.' },
  { name: 'MUSIC_SIGNALS_API_KEY', category: 'signals', type: 'string', required: false, secret: true, description: 'Bearer token for recommendation bridge sync endpoint.' },
  { name: 'MUSIC_BRIDGE_SERVER_TIMEOUT_MS', category: 'signals', type: 'int', min: 500, max: 60000, defaultValue: '4000', required: false, description: 'Timeout for bridge server requests.' },

  { name: 'ORCHESTRATOR_DEBUG', category: 'metrics', type: 'bool01', defaultValue: '0', required: false, description: 'Log orchestrator command calls to console.' },
  { name: 'MAX_CONCURRENT_YTDLP', category: 'playback', type: 'int', min: 1, max: 20, defaultValue: '3', required: false, description: 'Max concurrent yt-dlp processes for streaming (audio-pipeline).' },
  { name: 'MAX_CONCURRENT_YTDLP_SEARCH', category: 'playback', type: 'int', min: 1, max: 20, defaultValue: '5', required: false, description: 'Max concurrent yt-dlp search processes (youtube-search).' },
  { name: 'AUTOPLAY_PREFETCH_MIN_POOL', category: 'autoplay', type: 'int', min: 1, max: 20, defaultValue: '2', required: false, description: 'Skip prefetch when pool already has at least this many candidates.' },
  { name: 'AUTOPLAY_PREFETCH_FAST_DELAY_MS', category: 'autoplay', type: 'int', min: 0, max: 300000, defaultValue: '1000', required: false, description: 'Milliseconds before fast prefetch phase runs.' },
  { name: 'AUTOPLAY_PREFETCH_FULL_DELAY_MS', category: 'autoplay', type: 'int', min: 0, max: 600000, defaultValue: '15000', required: false, description: 'Milliseconds before full prefetch phase runs.' },
];

export function getRegistryMap() {
  return new Map(ENV_REGISTRY.map((row) => [row.name, row]));
}
