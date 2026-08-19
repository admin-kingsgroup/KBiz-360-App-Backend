// Stored filename for a service-pushed PDF (alert channel event or Finance-group chat post).
//
// Sanitize FIRST, strip any .pdf, cap at 100, THEN append .pdf — the storage layer's own
// safeName() slice(0,120) then cannot truncate the extension away. (Appending before
// truncating let a 120-char name ending ".html" survive as the stored extension →
// served as text/html from our origin = stored XSS.)
export const attachmentFilename = (name: string): string => {
  const base = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.pdf$/i, '').slice(0, 100);
  return `${base || 'document'}.pdf`;
};
