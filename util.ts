import prettyMs from 'pretty-ms';
import { logger } from './logger';

export function calculatePercentiles(values: number[]): Record<string, number> {
  if (values.length === 0) return {};
  
  const sorted = [...values].sort((a, b) => a - b);
  const percentiles = [10, 50, 90, 99];
  const result: Record<string, number> = {};
  
  for (const p of percentiles) {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    result[`p${p}`] = sorted[Math.max(0, index)] || 0;
  }
  
  return result;
}

export function displayPercentileTable(durations: number[], title: string) {
  if (durations.length === 0) return;
  
  logger.info(`- ${title} (${durations.length} samples)`);
  const percentiles = calculatePercentiles(durations);
  
  for (const [key, value] of Object.entries(percentiles)) {
    logger.info(`  - ${key}: ${prettyMs(value)}`);
  }
}

export const failureStats = {
  project: 0,
  action: {
    write: 0,
    checkpoint: 0,
    rollback: 0,
    preview: 0,
  }
}

export function random<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// add normal noise to a value, clamped to a minimum of 0
export function addNormalNoise(value: number, stddev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const noised = value + z * stddev;

  return Math.max(0, noised);
}

export function scheduleAtRate<T>(
  fn: () => Promise<T>,
  ratePerMinute: number,
  onError: (error: unknown) => void,
): () => void {
  const intervalMs = (60 * 1000) / (ratePerMinute);
  let timeoutId: NodeJS.Timeout;

  const scheduleNext = () => {
    const delay = addNormalNoise(intervalMs, intervalMs * 0.2);
    timeoutId = setTimeout(async () => {
      void fn().catch(onError);
      scheduleNext();
    }, delay);
  };

  scheduleNext();

  return () => clearTimeout(timeoutId);
}
