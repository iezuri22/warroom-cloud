// Classify DB errors as transient (worth retrying) vs structural (poison the key).
//
// Why this exists: when Neon hits compute-time quota, every request comes back
// as "Server error (HTTP status 402): ...quota...". Before this helper, the
// sync client treated every failure the same and PERMANENTLY poisoned every
// key in the batch — so a temporary quota blip would silently disable sync for
// critical keys (ui-state, todos-cache, etc.) until the user manually ran
// warroomSyncUnpoison(). We now flag those errors as transient so the client
// retries instead of banning.
//
// Anything not matched here is assumed structural (oversized value, malformed
// JSON, schema violation) and IS safe to poison.
export function isTransientDbError(e) {
  const msg = (e && e.message) || '';
  return /quota|HTTP status (?:402|408|5\d\d)|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|network|timeout/i.test(msg);
}

export function isQuotaError(e) {
  const msg = (e && e.message) || '';
  return /quota|HTTP status 402/i.test(msg);
}
