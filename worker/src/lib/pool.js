// Run an async worker over a list of items with bounded concurrency. Keeps
// `limit` tasks in flight at once, starting a new one as each finishes. Errors
// per item are caught by the worker fn itself (we don't want one failure to
// abort the batch); this just controls parallelism.

export async function runPool(items, limit, worker) {
  const queue = [...items];
  let active = 0;
  let index = 0;
  return new Promise((resolve) => {
    if (queue.length === 0) return resolve();
    const next = () => {
      while (active < limit && index < queue.length) {
        const item = queue[index++];
        active++;
        Promise.resolve(worker(item))
          .catch(() => {}) // worker handles its own errors; guard just in case
          .finally(() => {
            active--;
            if (index >= queue.length && active === 0) resolve();
            else next();
          });
      }
    };
    next();
  });
}
