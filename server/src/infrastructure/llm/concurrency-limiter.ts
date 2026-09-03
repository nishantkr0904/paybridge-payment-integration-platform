import { LLMConcurrencyLimitError } from './llm.types.js';

export interface ConcurrencyLimiterOptions {
  maxConcurrency?: number;
  maxQueueSize?: number;
}

export class ConcurrencyLimiter {
  private activeCount = 0;
  private readonly maxConcurrency: number;
  private readonly maxQueueSize: number;
  private readonly waitQueue: Array<() => void> = [];

  constructor(options?: ConcurrencyLimiterOptions) {
    this.maxConcurrency = options?.maxConcurrency ?? 10;
    this.maxQueueSize = options?.maxQueueSize ?? 50;
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  public getQueueLength(): number {
    return this.waitQueue.length;
  }

  public async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return;
    }

    if (this.waitQueue.length >= this.maxQueueSize) {
      throw new LLMConcurrencyLimitError(
        `LLM max concurrency (${this.maxConcurrency}) and queue limit (${this.maxQueueSize}) reached`
      );
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.activeCount++;
        resolve();
      });
    });
  }

  public release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    }
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
