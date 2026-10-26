/**
 * How much slower the Windows CI runner is: it renders without a GPU and ran the suite about 3×
 * slower (9.5 minutes, 12 s to open a thread). The config scales its timeouts by it; a spec with its
 * own absolute timeouts scales those too.
 */
export const slowdown = process.platform === "win32" ? 3 : 1;
