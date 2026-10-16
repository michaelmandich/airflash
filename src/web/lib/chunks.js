// Chunked uploads (docs/relay-mode.md), with the network kept behind a `transport` so the same
// code runs in the browser (XHR for progress) and in Node tests (fetch against a real node).
//
// The file is cut into `chunkBytes` pieces, each PUT to `.../chunks/:n?token=T` with up to
// `concurrency` in flight; the node writes chunk n at offset n×chunkBytes, so order does not
// matter and a chunk can be sent again. After a network error we ask `GET .../chunks` which
// pieces arrived and only send the rest (a Retry does the same, so a second attempt never
// re-sends what the node already has). `POST .../complete` seals the file.

const MAX_ATTEMPTS = 5;
const BACKOFF_CAP_MS = 8000;

/** How a file of `size` bytes is cut: `total` chunks, the last one short unless it divides evenly. */
export function chunkPlan(size, chunkBytes) {
  const total = Math.ceil(size / chunkBytes);
  const sizeOf = (n) => Math.min(chunkBytes, size - n * chunkBytes);
  return { total, chunkBytes, sizeOf, offset: (n) => n * chunkBytes };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Upload `file` (anything with `.size` and `.slice(start, end)`: a File, a Blob) in chunks.
 *
 * transport:
 *   get(url)                → parsed JSON body (throws on non-2xx; the error carries `.status`)
 *   post(url)               → parsed JSON body (same)
 *   put(url, body, onLoaded) → resolves on 2xx; rejects with an error carrying `.status`, or
 *                              `.network: true` when the request never got an answer
 * Errors without `.status` are treated as network errors (fetch throws a plain TypeError).
 * `onProgress(sentBytes)` = bytes of finished chunks + what the in-flight requests pushed so far.
 */
export async function uploadChunked({ fileUrl, token, file, chunkBytes, transport, onProgress, concurrency = 2, wait = sleep }) {
  const plan = chunkPlan(file.size, chunkBytes);
  const chunksUrl = `${fileUrl}/chunks`;
  const received = new Set(await fetchReceived(transport, chunksUrl, token, { quiet: true }));
  const inflight = new Map(); // n -> bytes pushed so far

  const report = () => {
    let done = 0;
    for (const n of received) done += plan.sizeOf(n);
    for (const loaded of inflight.values()) done += loaded;
    onProgress?.(Math.min(file.size, done));
  };

  // One resync for everyone: two workers failing at once must not race two GETs.
  let resyncing = null;
  const resync = () => (resyncing ??= fetchReceived(transport, chunksUrl, token).then((list) => {
    received.clear();
    for (const n of list) received.add(n);
    report();
  }).finally(() => { resyncing = null; }));

  const putChunk = async (n) => {
    const start = plan.offset(n);
    inflight.set(n, 0);
    try {
      await transport.put(`${chunksUrl}/${n}?token=${token}`, file.slice(start, start + plan.sizeOf(n)), (loaded) => {
        inflight.set(n, loaded);
        report();
      });
    } finally {
      inflight.delete(n);
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < plan.total) {
      const n = next++;
      for (let attempt = 0; ; attempt++) {
        if (received.has(n)) break;
        try {
          await putChunk(n);
          received.add(n);
          report();
          break;
        } catch (err) {
          // A 409 means the node has (or is still writing) this chunk; the resync below sorts it out.
          if (!isRecoverable(err) || attempt >= MAX_ATTEMPTS) throw err;
          await wait(Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt));
          await resync().catch(() => {}); // unreachable? the next PUT will tell us
        }
      }
    }
  };
  // Two passes: the second only runs if the node's view (after a resync) says something is still missing.
  for (let pass = 0; pass < 2; pass++) {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    if (received.size >= plan.total) break;
    next = 0; // walk the missing ones again
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await transport.post(`${fileUrl}/complete?token=${token}`);
      break;
    } catch (err) {
      // Only a lost answer is retried; the node's complete is idempotent, so asking twice is safe.
      if (err.status != null || attempt >= 3) throw err;
      await wait(1000 * 2 ** attempt);
    }
  }
  onProgress?.(file.size);
}

function isRecoverable(err) {
  return err.network || err.status == null || err.status === 409 || err.status >= 500;
}

async function fetchReceived(transport, chunksUrl, token, { quiet = false } = {}) {
  try {
    const { received } = await transport.get(`${chunksUrl}?token=${token}`);
    return (Array.isArray(received) ? received : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
  } catch (err) {
    if (quiet) return []; // first contact: nothing is there yet anyway, the PUTs will surface a real problem
    throw err;
  }
}
