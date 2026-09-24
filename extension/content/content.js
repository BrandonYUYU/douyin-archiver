/**
 * content.js — isolated world. Has chrome.* APIs but cannot see the page's
 * `fetch`; hook.js covers that half.
 *
 * This file is glue, deliberately: capture.js turns forwarded responses into
 * records, scroll.js drives the scrolling, stopRules.js decides when to stop, and
 * the service worker owns storage. What lives here is the wiring between them
 * plus the DOM-facing bits that cannot be tested in Node.
 *
 * The run lives HERE rather than in the popup, so closing the popup cannot
 * interrupt it, and rather than in the worker, because the worker cannot scroll
 * a page and may be evicted mid-run.
 */
(async () => {
  'use strict';

  // MV3 content scripts cannot use static `import`, so pull the shared ES
  // modules in dynamically. This requires lib/*.js in web_accessible_resources.
  const [
    protocol,
    targets,
    settingsMod,
    rpcMod,
    captureMod,
    scrollMod,
    stopMod,
    interruptMod,
    harvestMod
  ] = await Promise.all([
    import(chrome.runtime.getURL('lib/protocol.js')),
    import(chrome.runtime.getURL('lib/targets.js')),
    import(chrome.runtime.getURL('lib/settings.js')),
    import(chrome.runtime.getURL('lib/rpc.js')),
    import(chrome.runtime.getURL('lib/capture.js')),
    import(chrome.runtime.getURL('lib/scroll.js')),
    import(chrome.runtime.getURL('lib/stopRules.js')),
    import(chrome.runtime.getURL('lib/interruptions.js')),
    import(chrome.runtime.getURL('lib/domHarvest.js'))
  ]);

  const { readPageMessage, makeMessage, FROM_PAGE, TO_PAGE } = protocol;
  const { BROAD_URL_FILTERS, LISTS, SELECTORS, pageMatchesList } = targets;
  const { normalizeSettings, SETTINGS_KEY } = settingsMod;
  const { RPC } = rpcMod;
  const { captureListResponse } = captureMod;
  const { createRunner, createRunState, createDomPage } = scrollMod;
  const { describeStop, PAUSE_REASONS, advanceKnownStreak } = stopMod;
  const { createDomProbe, findInterruption, describeInterruption } = interruptMod;
  const { collectHrefs, recordsFromHrefs, shouldHarvest } = harvestMod;

  const log = (...args) => console.log('[dy-archiver]', ...args);

  let settings = normalizeSettings(null);

  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: RPC.GET_SETTINGS });
      if (response && response.ok) settings = normalizeSettings(response.settings);
    } catch (error) {
      // The worker may be starting up; defaults are fine until it answers.
      log('settings unavailable, using defaults:', error?.message || error);
    }
    return settings;
  }

  function pushConfigToHook() {
    window.postMessage(
      makeMessage(TO_PAGE.CONFIG, {
        filters: BROAD_URL_FILTERS,
        recon: settings.reconMode
      }),
      window.location.origin
    );
  }

  async function sendToWorker(message, { retry = true } = {}) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      // A sleeping worker rejects the first message while it spins up.
      if (retry) return sendToWorker(message, { retry: false });
      log('worker unreachable:', error?.message || error);
      return null;
    }
  }

  // --- capture ---------------------------------------------------------------

  const stats = {
    responses: 0,
    listResponses: 0,
    reconUrls: 0,
    stored: 0,
    dropped: 0,
    domHarvested: 0,
    lastListId: null,
    lastReason: null
  };

  /** The active run, or null. */
  let runner = null;
  let runState = null;

  async function handleResponsePayload(payload) {
    stats.responses += 1;

    // An empty archive here on purpose: this only collapses duplicates *within*
    // the page. Deduplication against everything ever captured is the worker's
    // job, since it is the only side that holds the full archive.
    const outcome = captureListResponse(payload, { archive: {} });
    stats.lastReason = outcome.reason;

    if (!outcome.accepted) {
      if (outcome.reason === 'not-a-list-url') {
        // Expected: the hook's URL filter is broad on purpose (targets.js).
        if (settings.reconMode) log('ignored non-list response:', payload.url);
      } else {
        log(`list response unusable (${outcome.reason}):`, payload.url);
      }
      return;
    }

    const { listId, result, merged } = outcome;
    stats.listResponses += 1;
    stats.lastListId = listId;
    stats.dropped += result.droppedCount;

    // Feed the run's stop signals. Done before storing, so an end-of-list page
    // still registers even if the worker is briefly unreachable.
    if (runState) {
      runState.listResponses += 1;
      runState.lastResponseAt = Date.now();
      if (result.hasMore !== undefined) runState.hasMore = result.hasMore;
      if (result.itemCount === 0) runState.emptyResponses += 1;
      else runState.emptyResponses = 0;
    }

    const batch = Object.values(merged.records);
    const reply = await sendToWorker({ type: RPC.INGEST, listId, records: batch });
    if (!reply || !reply.ok) {
      log(`captured ${batch.length} records but could not store them`, reply?.error || '');
      return;
    }

    stats.stored = reply.total;
    if (runState) {
      runState.added += reply.added;
      runState.knownThisRun += reply.known;
      // Accumulated across pages, because a 50-video streak usually spans several.
      runState.consecutiveKnown = advanceKnownStreak(runState.consecutiveKnown, reply);
    }

    log(
      `[${listId}] +${reply.added} new, ${reply.known} already known ` +
        `(page had ${result.itemCount}, dropped ${result.droppedCount}) ` +
        `→ ${reply.total} stored · hasMore=${result.hasMore} · ` +
        `knownStreak=${runState ? runState.consecutiveKnown : 0}` +
        `${reply.flushed ? ' · checkpointed' : ''}`
    );
  }

  window.addEventListener('message', (event) => {
    // Everything the page posts is hostile until proven otherwise.
    const message = readPageMessage(event, window);
    if (!message) return;

    switch (message.type) {
      case FROM_PAGE.HOOK_READY:
        // Load order between the two content scripts is not guaranteed, so config
        // is pushed both on our init and whenever the hook announces itself.
        pushConfigToHook();
        log('hook ready on', message.payload.href);
        break;

      case FROM_PAGE.RECON:
        stats.reconUrls += 1;
        break;

      case FROM_PAGE.RESPONSE:
        // Async because storing goes through the worker; a failure here must not
        // surface as an unhandled rejection inside a page event handler.
        handleResponsePayload(message.payload).catch((error) =>
          log('capture failed:', error?.message || error)
        );
        break;
    }
  });

  // --- runs ------------------------------------------------------------------

  /** Which list the current page is showing, if any. */
  function detectListId() {
    for (const listId of Object.keys(LISTS)) {
      if (pageMatchesList(window.location.href, listId)) return listId;
    }
    return null;
  }

  function runStatus() {
    if (!runState) {
      return { running: false, listId: null, stats: { ...stats }, detectedList: detectListId() };
    }
    return {
      running: !runState.stoppedReason,
      listId: runState.listId,
      paused: runState.paused,
      pauseReason: runState.pauseReason,
      steps: runState.steps,
      added: runState.added,
      stored: stats.stored,
      domHarvested: runState.domHarvested,
      consecutiveKnown: runState.consecutiveKnown,
      emptyResponses: runState.emptyResponses,
      hasMore: runState.hasMore,
      stoppedReason: runState.stoppedReason,
      detectedList: detectListId(),
      stats: { ...stats }
    };
  }

  const probe = createDomProbe(document, window);

  /** Ids already sent to the worker by the fallback this run, to avoid re-sending
   *  the same visible tiles on every scroll step. */
  const harvestedIds = new Set();

  /**
   * Read video ids straight out of the rendered tiles.
   *
   * Only reached when interception has gone quiet while the page is still
   * loading, which means the endpoint or response shape has changed. Yields URLs
   * with no metadata — enough to keep the archive complete until targets.js is
   * corrected.
   */
  async function harvestFromDom(state) {
    const hrefs = collectHrefs(document, SELECTORS.tileAnchors);
    const candidates = recordsFromHrefs(hrefs, { listId: state.listId }).filter(
      (record) => !harvestedIds.has(record.id)
    );
    if (candidates.length === 0) return;

    for (const record of candidates) harvestedIds.add(record.id);

    const reply = await sendToWorker({
      type: RPC.INGEST,
      listId: state.listId,
      records: candidates
    });
    if (!reply || !reply.ok) return;

    state.added += reply.added;
    state.domHarvested += reply.added;
    stats.stored = reply.total;
    stats.domHarvested += reply.added;

    if (reply.added > 0) {
      log(
        `DOM fallback: +${reply.added} new from ${candidates.length} visible tiles ` +
          '(no metadata — interception looks broken, check docs/findings.md)'
      );
    }
  }

  function onTick(state) {
    if (!shouldHarvest(state, settings, Date.now())) return;
    harvestFromDom(state).catch((error) => log('DOM fallback failed:', error?.message || error));
  }

  /**
   * Called by the runner every iteration, including while paused.
   *
   * Pausing on a captcha is what stops a blocked run from masquerading as a
   * finished one. The same check clears the pause once the dialog is gone, so
   * solving the puzzle by hand is all the user has to do.
   */
  function watchForInterruptions(state, api) {
    const interruption = findInterruption(probe, SELECTORS);

    if (interruption) {
      if (!state.paused) api.pause(interruption.kind);
      return;
    }

    // Only lift pauses that this watcher caused; a throttle backoff expires on
    // its own schedule and a user pause is not ours to clear.
    if (
      state.paused &&
      (state.pauseReason === PAUSE_REASONS.CAPTCHA || state.pauseReason === PAUSE_REASONS.LOGIN)
    ) {
      api.resume();
    }
  }

  function reportPause(state, reason) {
    const message =
      reason === PAUSE_REASONS.THROTTLE
        ? 'Douyin returned several empty pages. Waiting a minute before retrying — nothing captured is lost.'
        : describeInterruption(reason);

    log(`paused: ${reason} — ${message}`);
    sendToWorker({
      type: RPC.RUN_EVENT,
      kind: 'paused',
      reason,
      title: reason === PAUSE_REASONS.THROTTLE ? 'Archiving paused (slowing down)' : 'Archiving paused',
      message
    });
  }

  function reportResume(state, reason) {
    log(`resumed after ${reason}`);
    sendToWorker({ type: RPC.RUN_EVENT, kind: 'resumed', reason });
  }

  async function startRun(requestedListId) {
    if (runner) return { ok: false, error: 'A run is already in progress.' };

    const listId = requestedListId || detectListId();
    if (!listId) {
      return {
        ok: false,
        error: 'This page is not a 点赞 or 收藏 list. Open the list tab first.'
      };
    }

    await loadSettings();
    harvestedIds.clear();
    runState = createRunState({ listId, startedAt: Date.now() });
    runner = createRunner({
      page: createDomPage(window, document),
      state: runState,
      settings,
      watch: watchForInterruptions,
      onPause: reportPause,
      onResume: reportResume,
      onTick
    });

    log(`run started on "${listId}" (${settings.minDelayMs}-${settings.maxDelayMs}ms pacing)`);

    // Deliberately not awaited: the reply goes back to the popup immediately so
    // it can be closed while the run continues.
    runner
      .run()
      .then(async (result) => {
        log(
          `run finished: ${describeStop(result.reason)} ` +
            `${result.steps} scrolls, +${result.added} new, ` +
            `${runState.knownThisRun} already known, ${stats.stored} stored`
        );
        await sendToWorker({ type: RPC.RUN_EVENT, kind: 'finished', reason: result.reason });
        await sendToWorker({
          type: RPC.SET_LAST_RUN,
          summary: {
            listId,
            reason: result.reason,
            steps: result.steps,
            added: result.added,
            known: runState.knownThisRun,
            domHarvested: runState.domHarvested,
            elapsedMs: result.elapsedMs,
            total: stats.stored
          }
        });
      })
      .catch((error) => log('run failed:', error?.message || error))
      .finally(() => {
        runner = null;
      });

    return { ok: true, status: runStatus() };
  }

  function stopRun() {
    if (!runner) return { ok: false, error: 'No run is in progress.' };
    runner.requestStop();
    return { ok: true, status: runStatus() };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case RPC.START_RUN:
        startRun(message.listId).then(sendResponse);
        return true;
      case RPC.STOP_RUN:
        sendResponse(stopRun());
        return false;
      case RPC.GET_RUN_STATUS:
        sendResponse({ ok: true, status: runStatus() });
        return false;
      default:
        return false;
    }
  });

  // React to a settings change without needing a page reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    pushConfigToHook();
    log('settings updated; recon mode =', settings.reconMode);
  });

  await loadSettings();
  pushConfigToHook();
  log(`content script ready on "${detectListId() || 'a non-list page'}"`);

  // Debugging surface for the recon walkthrough in docs/findings.md. Lives on the
  // isolated world's window, so the page cannot see or tamper with it.
  Object.defineProperty(window, '__dyArchiver', {
    value: {
      stats,
      status: runStatus,
      state: () => sendToWorker({ type: RPC.GET_STATE })
    },
    enumerable: false
  });
})();
