// Runtime tuning; rebuild the plugin after editing.

// Per-view work limits. The soft time budget covers checks, before source/style writes.
export const FRAME_BUDGET_MS = 5;
export const MAX_ITEMS_PER_FRAME = 16;
export const MAX_CONCURRENT_LOADS = 2;

// Required image pixels = displayed longest edge × device pixel ratio × headroom.
export const RESOLUTION_HEADROOM = 1.15;
// Downshift when required pixels are at most this fraction of the smaller tier.
export const DOWNSHIFT_RATIO = 0.8;
export const GESTURE_SETTLE_MS = 200;

export const IMAGE_LOAD_TIMEOUT_MS = 10_000;
export const VIEW_POLL_INTERVAL_MS = 1_000;
// Coalesce sync bursts without rebuilding resource indexes on every vault event.
export const FILE_REFRESH_DELAY_MS = 50;
