import { sql } from 'drizzle-orm';
import type { InvalidationBus, InvalidationMessage } from '../interfaces';

/**
 * The cross-machine invalidation bus for the Postgres tier: `pg_notify`
 * carries invalidation messages to a dedicated `LISTEN` connection on every
 * instance. The flagship path is {@link publishInTx}: run inside the caller's
 * business transaction, Postgres delivers the notification **on commit** and
 * drops it on rollback — the invalidation is atomic with the data change
 * (transactional invalidation; the dual-write fix applied to caches).
 *
 * Best-effort by the stalefree contract: notifications missed while a
 * listener reconnects are NOT recovered — the TTL backstop bounds staleness.
 * This file deliberately re-applies the hardening lessons from
 * `@nest-native/messaging`'s wake listener: a client ended mid-connect never
 * settles its `connect()` promise (park on `end`/`error` first and race);
 * channels are allow-listed AND capped at Postgres's 63-byte identifier limit
 * (beyond it `LISTEN` silently truncates while `pg_notify` RAISES — inside
 * the caller's transaction); documented factories set `keepAlive: true`
 * because a pure-receive socket never detects half-open death without it.
 */

/** The slice of `pg.Client` the listener uses — structural, hermetically fakeable. */
export interface PgListenConnection {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(
    event: 'notification',
    listener: (message: { payload?: string }) => void,
  ): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

/** Anything that can execute a drizzle query — a NodePgDatabase or one of its transactions. */
export interface PgExecutor {
  execute(query: unknown): Promise<unknown>;
}

export interface PostgresBusOptions {
  /**
   * Factory for the dedicated LISTEN connection, e.g.
   * `() => new pg.Client({ connectionString, keepAlive: true })` — a fresh
   * client per reconnect attempt, never a pooled connection.
   */
  connect: () => PgListenConnection;
  /** The base (non-transactional) drizzle handle used by fire-and-forget `publish`. */
  db: PgExecutor;
  /** NOTIFY channel. Identifier-safe, max 63 chars. Default `stalefree_invalidation`. */
  channel?: string;
  /** Delay between listener reconnect attempts. Default 5000ms. */
  reconnectDelayMs?: number;
  /** Bus failures are reported here; `publish` never throws into the request path. */
  onError?: (error: unknown) => void;
}

const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// pg_notify payloads are capped (~8000 bytes); chunk below it with headroom.
const MAX_PAYLOAD_BYTES = 7_500;

export function assertValidChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel.length > 63) {
    throw new Error(
      `invalid channel ${JSON.stringify(channel)}: must match ${String(CHANNEL_PATTERN)} and be at most 63 characters`,
    );
  }
}

/**
 * Split one message into pg_notify-sized chunks. Keys/tags are length-capped
 * by validation, so chunking by greedy fill always terminates; a `clear`
 * passes through unchanged.
 */
export function chunkMessage(
  message: InvalidationMessage,
): InvalidationMessage[] {
  if ('clear' in message) {
    return [message];
  }
  const chunks: InvalidationMessage[] = [];
  for (const field of ['tags', 'keys'] as const) {
    const items = message[field];
    if (!items || items.length === 0) {
      continue;
    }
    let batch: string[] = [];
    for (const item of items) {
      const candidate = [...batch, item];
      if (
        batch.length > 0 &&
        JSON.stringify({ [field]: candidate }).length > MAX_PAYLOAD_BYTES
      ) {
        chunks.push({ [field]: batch });
        batch = [item];
      } else {
        batch = candidate;
      }
    }
    chunks.push({ [field]: batch });
  }
  return chunks;
}

export class PostgresInvalidationBus implements InvalidationBus {
  readonly #handlers = new Set<(message: InvalidationMessage) => void>();
  readonly #options: PostgresBusOptions;
  readonly #channel: string;
  readonly #reconnectDelayMs: number;
  #loop: Promise<void> | null = null;
  #current: PgListenConnection | null = null;
  #stopped = false;
  #abortSleep: (() => void) | null = null;

  constructor(options: PostgresBusOptions) {
    this.#options = options;
    this.#channel = options.channel ?? 'stalefree_invalidation';
    assertValidChannel(this.#channel);
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    if (
      !Number.isFinite(this.#reconnectDelayMs) ||
      this.#reconnectDelayMs < 1
    ) {
      throw new Error(
        `invalid reconnectDelayMs ${String(this.#reconnectDelayMs)}: must be a finite number >= 1`,
      );
    }
  }

  /** Launch the LISTEN supervision loop (idempotent). */
  start(): void {
    this.#loop ??= this.#supervise();
  }

  /**
   * Fire-and-forget notify on the base handle. Never throws — a failed
   * publish costs staleness-until-TTL on other instances, nothing more.
   */
  publish(message: InvalidationMessage): void {
    for (const chunk of chunkMessage(message)) {
      void this.#notify(this.#options.db, chunk).catch((error) => {
        this.#options.onError?.(error);
      });
    }
  }

  /**
   * Transactional publish: run on the caller's drizzle TRANSACTION handle so
   * Postgres delivers the invalidation on commit and drops it on rollback.
   * Awaited and NOT fail-open — atomicity is the whole point here, and with a
   * validated channel + capped payload, `pg_notify` has no failure mode left
   * that the caller's transaction shouldn't hear about.
   */
  async publishInTx(tx: PgExecutor, message: InvalidationMessage): Promise<void> {
    for (const chunk of chunkMessage(message)) {
      await this.#notify(tx, chunk);
    }
  }

  subscribe(handler: (message: InvalidationMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.#stopped = true;
    this.#abortSleep?.();
    const current = this.#current;
    if (current) {
      await this.#endQuietly(current);
    }
    await this.#loop;
    this.#handlers.clear();
  }

  #notify(executor: PgExecutor, chunk: InvalidationMessage): Promise<unknown> {
    return executor.execute(
      sql`select pg_notify(${this.#channel}, ${JSON.stringify(chunk)})`,
    );
  }

  async #supervise(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#session();
      } catch (error) {
        this.#options.onError?.(error);
      }
      if (!this.#stopped) {
        await this.#sleep(this.#reconnectDelayMs);
      }
    }
  }

  async #session(): Promise<void> {
    const client = this.#options.connect();
    this.#current = client;
    try {
      // Park BEFORE connect() and race: a client ended mid-connect emits
      // 'end' but never settles connect() — an un-raced await would deadlock
      // close() forever (the messaging wake lesson, verified against pg).
      let dead = false;
      const parked = new Promise<void>((resolve, reject) => {
        client.on('error', (error) => {
          dead = true;
          reject(error);
        });
        client.on('end', () => {
          dead = true;
          resolve();
        });
      });
      parked.catch(() => undefined);
      client.on('notification', (message) => this.#onNotification(message));
      await Promise.race([client.connect(), parked]);
      if (dead) {
        return;
      }
      await client.query(`LISTEN "${this.#channel}"`);
      await parked;
    } finally {
      this.#current = null;
      await this.#endQuietly(client);
    }
  }

  #onNotification(message: { payload?: string }): void {
    let parsed: InvalidationMessage;
    try {
      parsed = JSON.parse(message.payload ?? '') as InvalidationMessage;
    } catch (error) {
      this.#options.onError?.(error); // malformed payload: drop, keep listening
      return;
    }
    for (const handler of [...this.#handlers]) {
      try {
        handler(parsed);
      } catch (error) {
        // pg emits 'notification' from its socket-data handler — a throwing
        // subscriber must never become an uncaught exception there.
        this.#options.onError?.(error);
      }
    }
  }

  async #endQuietly(client: PgListenConnection): Promise<void> {
    try {
      await client.end();
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#abortSleep = null;
        resolve();
      }, ms);
      this.#abortSleep = () => {
        clearTimeout(timer);
        this.#abortSleep = null;
        resolve();
      };
    });
  }
}
