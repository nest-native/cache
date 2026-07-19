import { unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { InvalidationBus, InvalidationMessage } from '../interfaces';

/**
 * The same-machine, multi-process invalidation bus — for the classic app +
 * worker split sharing one SQLite file (processes sharing a SQLite database
 * are on one machine by definition, so for the SQLite tier this bus is the
 * whole cross-process story).
 *
 * Topology: the first process to bind the unix-socket path becomes the HUB;
 * every other process connects as a PEER. A frame published anywhere is
 * dispatched to the publisher's own subscribers, sent to the hub, and
 * re-broadcast by the hub to every other connection. If the hub dies, each
 * peer re-runs the bind-or-connect dance after `reconnectDelayMs` — the first
 * to bind is the new hub (stale socket files from a crashed hub are detected
 * by a probe connect and unlinked, the WakeSocket pattern). Frames lost during
 * a re-election are NOT recovered: the TTL backstop bounds the staleness, the
 * same contract as every stalefree bus.
 *
 * Wire format: newline-delimited JSON `InvalidationMessage` frames. A frame
 * larger than `MAX_FRAME_BYTES` marks a broken producer — the connection is
 * dropped (values never travel on this bus; only keys/tags do, and both are
 * length-capped, so legitimate frames are small).
 */
export interface SocketBusOptions {
  /** Unix-socket path (Windows: a `\\.\pipe\` name). Same value in every process. */
  path: string;
  /** Delay before re-running bind-or-connect after a drop. Default 1000ms. */
  reconnectDelayMs?: number;
  /** Bus failures are reported here; they never throw into the request path. */
  onError?: (error: unknown) => void;
}

const MAX_FRAME_BYTES = 65_536;

export class SocketInvalidationBus implements InvalidationBus {
  readonly #handlers = new Set<(message: InvalidationMessage) => void>();
  readonly #options: SocketBusOptions;
  readonly #reconnectDelayMs: number;
  #server: Server | null = null; // non-null when acting as hub
  #hubConnections = new Set<Socket>();
  #peer: Socket | null = null; // non-null when acting as peer
  #stopped = false;
  #started = false;
  #abortSleep: (() => void) | null = null;
  #supervision: Promise<void> | null = null;

  constructor(options: SocketBusOptions) {
    this.#options = options;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    if (
      !Number.isFinite(this.#reconnectDelayMs) ||
      this.#reconnectDelayMs < 1
    ) {
      throw new Error(
        `invalid reconnectDelayMs ${String(this.#reconnectDelayMs)}: must be a finite number >= 1`,
      );
    }
  }

  /** Join the mesh (bind as hub or connect as peer). Idempotent. */
  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#supervision = this.#supervise();
    // Give the first attach attempt a chance to settle so callers that await
    // start() publish into a connected mesh; later re-elections happen in the
    // background.
    await this.#attached;
  }

  #attached: Promise<void> = Promise.resolve();

  async #supervise(): Promise<void> {
    while (!this.#stopped) {
      let resolveAttached!: () => void;
      this.#attached = new Promise((resolve) => (resolveAttached = resolve));
      try {
        // The role's end-signal travels WRAPPED in an object: an async
        // function resolving with a bare promise would flatten it, making
        // this await block until the role ENDS — start() would hang forever.
        const { ended } = await this.#attach();
        resolveAttached();
        await ended; // holds until this role ends (hub closed / peer dropped)
      } catch (error) {
        resolveAttached();
        this.#options.onError?.(error);
      }
      if (!this.#stopped) {
        await this.#sleep(this.#reconnectDelayMs);
      }
    }
  }

  /** One role lifetime; `ended` settles when the role ends. */
  async #attach(): Promise<{ ended: Promise<void> }> {
    try {
      return await this.#becomeHub();
    } catch (error) {
      if (!isAddrInUse(error)) {
        throw error;
      }
      try {
        return await this.#becomePeer();
      } catch (peerError) {
        // Neither bind nor connect: likely a stale file from a crashed hub.
        this.#options.onError?.(peerError);
        tryUnlink(this.#options.path);
        return await this.#becomeHub();
      }
    }
  }

  #becomeHub(): Promise<{ ended: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#onHubConnection(socket));
      server.once('error', reject);
      server.listen(this.#options.path, () => {
        server.removeListener('error', reject);
        this.#server = server;
        const ended = new Promise<void>((resolveEnd) => {
          server.once('close', () => resolveEnd());
        });
        resolve({ ended });
      });
    });
  }

  #onHubConnection(socket: Socket): void {
    this.#hubConnections.add(socket);
    socket.once('error', () => socket.destroy());
    socket.once('close', () => this.#hubConnections.delete(socket));
    readFrames(socket, this.#options.onError, (message) => {
      this.#dispatch(message);
      this.#fanOut(message, socket);
    });
  }

  #becomePeer(): Promise<{ ended: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.#options.path);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        this.#peer = socket;
        const ended = new Promise<void>((resolveEnd) => {
          socket.once('close', () => {
            this.#peer = null;
            resolveEnd();
          });
          socket.once('error', () => socket.destroy());
        });
        readFrames(socket, this.#options.onError, (message) =>
          this.#dispatch(message),
        );
        resolve({ ended });
      });
    });
  }

  publish(message: InvalidationMessage): void {
    // Local subscribers always hear it (two caches in one process must stay
    // coherent even while the mesh is re-electing).
    this.#dispatch(message);
    const frame = JSON.stringify(message) + '\n';
    if (this.#server) {
      this.#fanOut(message, null);
      return;
    }
    this.#peer?.write(frame, this.onWriteError);
  }

  // TS-private (not #) so the write-failure branch is unit-testable directly —
  // a mid-teardown write error is not deterministically triggerable over a
  // real socket (the wake-socket precedent). A failed frame write only costs
  // staleness-until-TTL on the missed instances.
  private readonly onWriteError = (error?: Error | null): void => {
    if (error) {
      this.#options.onError?.(error);
    }
  };

  /** Hub-side: send to every connection except the origin (it already applied). */
  #fanOut(message: InvalidationMessage, origin: Socket | null): void {
    const frame = JSON.stringify(message) + '\n';
    for (const connection of this.#hubConnections) {
      if (connection !== origin) {
        connection.write(frame, this.onWriteError);
      }
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
    const server = this.#server;
    if (server) {
      for (const connection of this.#hubConnections) {
        connection.destroy();
      }
      this.#hubConnections.clear();
      this.#server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      tryUnlink(this.#options.path);
    }
    this.#peer?.destroy();
    this.#peer = null;
    await this.#supervision;
    this.#handlers.clear();
  }

  #dispatch(message: InvalidationMessage): void {
    for (const handler of [...this.#handlers]) {
      try {
        handler(message);
      } catch {
        // Subscriber errors never break the bus (idempotent evictions + TTL).
      }
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

/** Attach an NDJSON frame reader with a max-size guard to a socket. */
function readFrames(
  socket: Socket,
  onError: ((error: unknown) => void) | undefined,
  onMessage: (message: InvalidationMessage) => void,
): void {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_FRAME_BYTES) {
      onError?.(new Error('socket-bus frame exceeds the size cap'));
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        onMessage(JSON.parse(raw) as InvalidationMessage);
      } catch (error) {
        onError?.(error); // malformed frame: drop it, keep the connection
      }
      newline = buffer.indexOf('\n');
    }
  });
}

function isAddrInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or a Windows pipe name with no filesystem entry.
  }
}
