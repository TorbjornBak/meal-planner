export interface PhotoPassProgress {
  done: number;
  total: number;
  found: number;
}

/** Run a best-effort photo pass with a small, observable concurrency bound. */
export async function runPhotoPass(
  ids: string[],
  fetchPhoto: (id: string) => Promise<boolean>,
  onProgress: (progress: PhotoPassProgress) => void,
  concurrency = 3,
): Promise<number> {
  let next = 0;
  let done = 0;
  let found = 0;
  onProgress({ done, total: ids.length, found });

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;

      try {
        if (await fetchPhoto(ids[index])) found += 1;
      } catch {
        // One missing or unreachable source must not stop the rest of the pass.
      }
      done += 1;
      onProgress({ done, total: ids.length, found });
    }
  }

  const workerCount = Math.min(ids.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return found;
}
