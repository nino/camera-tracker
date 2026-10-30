/**
 * Saves text as a file through a temporary download link. Works in browsers;
 * in the Tauri app this relies on the webview's download handling (not yet
 * checked in WKWebView; a native save dialog would need tauri-plugin-dialog).
 */
export function downloadText(
   filename: string,
   text: string,
   type = "text/plain",
): void {
   const url = URL.createObjectURL(new Blob([text], { type }));
   const link = document.createElement("a");
   link.href = url;
   link.download = filename;
   document.body.append(link);
   link.click();
   link.remove();
   // Revoke after the click has been handled.
   setTimeout(() => URL.revokeObjectURL(url), 0);
}
