type DesktopJob = {
  priority: boolean;
  cancelled: () => boolean;
  start: () => void;
};

/**
 * One screen, one operation at a time. A priority job (a send) jumps ahead of queued scans,
 * and a job whose client already gave up is dropped instead of burning minutes of OCR.
 */
export function createDesktopQueue() {
  const jobs: DesktopJob[] = [];
  let busy = false;
  const pump = () => {
    if (busy) return;
    const index = jobs.findIndex((job) => job.priority);
    const [job] = jobs.splice(index < 0 ? 0 : index, 1);
    if (!job) return;
    busy = true;
    job.start();
  };
  return <T>(
    operation: () => Promise<T>,
    options: { priority?: boolean; cancelled?: () => boolean } = {},
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const done = () => {
        busy = false;
        pump();
      };
      jobs.push({
        priority: options.priority === true,
        cancelled: options.cancelled ?? (() => false),
        start: () => {
          if (options.cancelled?.()) {
            reject(Error('request_cancelled'));
            done();
            return;
          }
          operation().then(resolve, reject).finally(done);
        },
      });
      pump();
    });
}
