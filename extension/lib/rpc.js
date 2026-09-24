/**
 * rpc.js — message names for extension-internal messaging
 * (content script ↔ service worker ↔ popup) via chrome.runtime.sendMessage.
 *
 * Distinct from lib/protocol.js, which covers the page↔content-script channel.
 * Those messages are untrusted; these ones are not, because they cannot
 * originate outside the extension.
 */

export const RPC = {
  /** popup/content → worker */
  GET_SETTINGS: 'rpc:get-settings',
  SET_SETTINGS: 'rpc:set-settings',

  /** content → worker: a batch of freshly captured records */
  INGEST: 'rpc:ingest',

  /** popup → worker: counters and last-run summary for display */
  GET_STATE: 'rpc:get-state',

  /** popup/manage page → worker: the whole archive, for writing a file */
  EXPORT_RECORDS: 'rpc:export-records',

  /** manage page → worker: merge records read back from a file */
  IMPORT_RECORDS: 'rpc:import-records',

  /** manage page → worker: delete everything (destructive, confirmed in the UI) */
  CLEAR_ARCHIVE: 'rpc:clear-archive',

  /** content → worker: how the run that just finished went */
  SET_LAST_RUN: 'rpc:set-last-run',

  /**
   * content → worker: something happened that the user should see (a captcha
   * pause, a resume). Content scripts cannot raise notifications themselves.
   */
  RUN_EVENT: 'rpc:run-event',

  /**
   * popup → CONTENT SCRIPT (via chrome.tabs.sendMessage), not the worker.
   * The run lives in the page's content script, so the popup can be closed
   * without interrupting it; these messages just start, stop and inspect it.
   */
  START_RUN: 'rpc:start-run',
  STOP_RUN: 'rpc:stop-run',
  GET_RUN_STATUS: 'rpc:get-run-status'
};
