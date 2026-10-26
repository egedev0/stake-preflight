/** Median, 95th percentile and longest frame of a list of frame times (ms). */
export function frameStats(frames) {
  if (!frames.length) return null;
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
  return {
    frames: frames.length,
    median: at(0.5),
    p95: at(0.95),
    longest: sorted.at(-1),
    over100: frames.filter((ms) => ms > 100).length,
  };
}

export const describeFrames = (stats) =>
  stats
    ? `${Math.round(1000 / stats.median)} fps median, 95% of frames under ${Math.round(stats.p95)} ms, longest ${Math.round(stats.longest)} ms`
    : 'no frames recorded';
