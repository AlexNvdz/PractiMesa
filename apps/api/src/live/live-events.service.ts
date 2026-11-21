import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';

/** What changed (migration 0010): the terminal refetches it by id. */
export interface LiveEvent {
  type: 'order' | 'table';
  id: string;
  organization_id: string;
  location_id: string;
}

/** null = the feed was interrupted and events may have been lost: the subscriber must resync. */
export type LiveListener = (event: LiveEvent | null) => void;

const RETRY_MS = 1000;

/**
 * Postgres LISTEN on live_events, fanned out to the open SSE streams of this instance. Every instance
 * listens on its own connection, so it also works with several API instances behind a balancer.
 */
@Injectable()
export class LiveEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveEventsService.name);
  private readonly listeners = new Set<LiveListener>();
  private client?: Client;
  private stopped = false;

  onModuleInit() {
    void this.listen();
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.client?.end();
  }

  subscribe(listener: LiveListener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private publish(event: LiveEvent | null) {
    for (const listener of this.listeners) listener(event);
  }

  /** Keeps one LISTEN connection open; after a drop, subscribers are told to resync and it reconnects. */
  private async listen() {
    while (!this.stopped) {
      const client = (this.client = new Client({ connectionString: process.env.DATABASE_URL }));
      const ended = new Promise((resolve) => client.once('end', resolve));
      client.on('error', (err) => this.logger.warn(`Live events connection error: ${err.message}`));
      client.on('notification', (msg) => this.publish(JSON.parse(msg.payload!) as LiveEvent));
      try {
        await client.connect();
        await client.query('LISTEN live_events');
        await ended;
      } catch (err) {
        this.logger.warn(`Live events unavailable: ${(err as Error).message}`);
        await client.end();
      }
      if (this.stopped) return;
      this.publish(null);
      await sleep(RETRY_MS);
    }
  }
}
