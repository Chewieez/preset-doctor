/** Hands bytes to the browser's downloads, from memory. No request leaves the page. */
export function saveDownload(fileName: string, data: Uint8Array, type = 'application/zip'): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // The download has started by now; give slow machines a while before freeing the memory.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
