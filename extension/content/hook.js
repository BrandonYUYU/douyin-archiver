/**
 * hook.js — runs in the page's own JavaScript world (manifest: world "MAIN",
 * run_at "document_start"), before Douyin's bundle installs its own fetch
 * wrappers.
 *
 * Its entire job: notice list responses the page fetches for itself, and forward
 * a copy to the isolated content script. It does not scroll, store, or decide
 * anything.
 *
 * Constraints that shape this file, all non-negotiable:
 *
 *  1. NO chrome.* APIS EXIST HERE. The MAIN world is the page's world. So this
 *     file cannot `import` extension modules — hence the duplicated protocol
 *     constants below, which test/protocol.test.js keeps honest.
 *  2. NEVER BREAK THE PAGE. Every hook wraps the original in try/catch and
 *     always returns the original's result. A Response body may only be read
 *     through `.clone()`; reading the original would consume the stream Douyin
 *     is about to read, and its feed would break.
 *  3. Assume nothing about ordering. The isolated script may load before or
 *     after this one, so we announce readiness AND accept config at any time.
 */
(() => {
  'use strict';

  // --- duplicated from lib/protocol.js (see constraint 1) --------------------
  const MSG_SOURCE = 'dy-archiver';
  const PROTOCOL_VERSION = 1;
  const T_HOOK_READY = 'dya:hook-ready';
  const T_RESPONSE = 'dya:response';
  const T_RECON = 'dya:recon';
  const T_CONFIG = 'dya:config';
  // --------------------------------------------------------------------------

  const INSTALL_FLAG = '__dyArchiverHookInstalled';
  if (window[INSTALL_FLAG]) return;
  window[INSTALL_FLAG] = true;

  const state = {
    /** Broad default; content.js narrows this via a CONFIG message. */
    filters: ['/aweme/v1/web/'],
    recon: false
  };

  function post(type, payload) {
    try {
      window.postMessage(
        { source: MSG_SOURCE, version: PROTOCOL_VERSION, type, payload },
        window.location.origin
      );
    } catch {
      /* a postMessage failure must never propagate into page code */
    }
  }

  function reconLog(kind, method, url) {
    if (!state.recon) return;
    try {
      // Printed in the page console so you can copy it straight into
      // docs/findings.md. Filter DevTools on "[dy-archiver]".
      console.log(`[dy-archiver][recon] ${kind} ${method} ${url}`);
    } catch {
      /* ignore */
    }
    post(T_RECON, { kind, method, url });
  }

  function absolute(url) {
    try {
      return new URL(String(url), window.location.href).href;
    } catch {
      return typeof url === 'string' ? url : '';
    }
  }

  function isInteresting(url) {
    return state.filters.some((needle) => url.includes(needle));
  }

  /** Extract a URL from any of fetch's argument shapes. */
  function urlFromFetchArgs(args) {
    const input = args && args[0];
    if (!input) return '';
    if (typeof input === 'string') return absolute(input);
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    if (typeof input === 'object' && typeof input.url === 'string') return absolute(input.url);
    return '';
  }

  function methodFromFetchArgs(args) {
    try {
      const [input, init] = args;
      if (init && typeof init.method === 'string') return init.method.toUpperCase();
      if (input && typeof input === 'object' && typeof input.method === 'string') {
        return input.method.toUpperCase();
      }
    } catch {
      /* ignore */
    }
    return 'GET';
  }

  // --- fetch ----------------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const promise = originalFetch.apply(this, args);
      try {
        const url = urlFromFetchArgs(args);
        if (url) {
          reconLog('fetch', methodFromFetchArgs(args), url);
          if (isInteresting(url)) {
            // Second handler is a no-op so this derived promise can never
            // surface as an unhandled rejection; the page still sees `promise`.
            promise.then(
              (response) => {
                try {
                  // MUST clone: the page has not read this body yet.
                  response
                    .clone()
                    .text()
                    .then((body) => {
                      post(T_RESPONSE, {
                        kind: 'fetch',
                        url,
                        status: response.status,
                        body
                      });
                    })
                    .catch(() => {});
                } catch {
                  /* ignore */
                }
              },
              () => {}
            );
          }
        }
      } catch {
        /* never let instrumentation break the page's own fetch */
      }
      return promise;
    };
  }

  // --- XMLHttpRequest -------------------------------------------------------
  // Douyin's list pagination has historically used XHR, so both are covered.
  const XhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XhrProto) {
    const originalOpen = XhrProto.open;
    const originalSend = XhrProto.send;

    XhrProto.open = function patchedOpen(method, url, ...rest) {
      try {
        this.__dyaUrl = absolute(url);
        this.__dyaMethod = String(method || 'GET').toUpperCase();
      } catch {
        /* ignore */
      }
      return originalOpen.call(this, method, url, ...rest);
    };

    XhrProto.send = function patchedSend(...args) {
      try {
        const url = this.__dyaUrl;
        if (url) {
          reconLog('xhr', this.__dyaMethod || 'GET', url);
          if (isInteresting(url)) {
            this.addEventListener(
              'load',
              () => {
                try {
                  const body = readXhrBody(this);
                  if (body) {
                    post(T_RESPONSE, {
                      kind: 'xhr',
                      url,
                      status: this.status,
                      body
                    });
                  }
                } catch {
                  /* ignore */
                }
              },
              { once: true }
            );
          }
        }
      } catch {
        /* ignore */
      }
      return originalSend.apply(this, args);
    };
  }

  /**
   * Read an XHR body as text without disturbing it.
   * `responseText` throws for blob/arraybuffer response types, so check first.
   */
  function readXhrBody(xhr) {
    const type = xhr.responseType;
    if (type === '' || type === 'text') return xhr.responseText || '';
    if (type === 'json') {
      try {
        return xhr.response == null ? '' : JSON.stringify(xhr.response);
      } catch {
        return '';
      }
    }
    return '';
  }

  // --- config channel -------------------------------------------------------
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.source !== MSG_SOURCE || data.version !== PROTOCOL_VERSION) return;
      if (data.type !== T_CONFIG) return;

      const payload = data.payload || {};
      if (Array.isArray(payload.filters)) {
        const filters = payload.filters.filter(
          (item) => typeof item === 'string' && item.length > 0
        );
        if (filters.length) state.filters = filters;
      }
      if (typeof payload.recon === 'boolean') state.recon = payload.recon;
    } catch {
      /* ignore */
    }
  });

  post(T_HOOK_READY, { href: window.location.href });
})();
