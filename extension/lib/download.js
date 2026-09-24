/**
 * download.js — save text to a file from an extension page.
 *
 * Uses a Blob plus a synthetic anchor click rather than the chrome.downloads
 * API, which keeps the extension's permission list smaller: downloads triggered
 * this way need no permission at all. Service workers cannot do this
 * (URL.createObjectURL does not exist there), which is why exporting is driven
 * from the popup/manage page rather than the worker.
 */

export function downloadText(filename, text, mimeType = 'application/octet-stream') {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // The download has already started; the URL only needs to outlive the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const MIME = {
  JSON: 'application/json',
  CSV: 'text/csv'
};
