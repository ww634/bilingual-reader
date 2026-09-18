// App version, shown in Settings so you can confirm the PWA refreshed to the
// latest code. This file is served cache-first from the service-worker shell
// cache, so the number here reflects the CODE ACTUALLY RUNNING: if it still
// shows the old number after reopening, the update hasn't landed yet.
//
// Keep this in sync with SHELL_CACHE in sw.js — bump both together on each
// deploy.
export const APP_VERSION = "37";
