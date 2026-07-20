import { statSync, unlinkSync } from 'node:fs';
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
 * to bind is the new hub. A stale socket file from a crashed hub is reclaimed
 * only after TWO consecutive refused cycles (a live hub mid-listen also
 * refuses briefly), and reclaiming unlinks then RETRIES the dance rather than
 * binding blindly — racing recoverers funnel through bind-or-connect, so one
 * of them wins and the rest connect to it. As a last line of defense the hub
 * self-checks its socket file's inode every few cycles and resigns if the
 * path was yanked from under it (re-election heals what any residual race
 * breaks; nothing is ever stranded silently).
 *
 * Frames lost during a re-election are NOT recovered: the TTL backstop bounds
 * the staleness, the same contract as every stalefree bus. A frame too large
 * for the wire degrades ON THE SEND SIDE to `{ clear: true }` — the receivers
 * evict everything (colder cache, never staler data).
 *
 * Wire format: newline-delimited JSON `InvalidationMessage` frames.
 *
 * Security note: any local process that can reach the socket path can publish
 * evictions (worst case: a cold cache). Place the socket in a directory only
 * your app's user can access (e.g. mode 0700), not a world-writable /tmp.
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
// Degrade to {clear:true} before the receiver-side cap can ever trigger.
const MAX_SEND_BYTES = 60_000;

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
  #refusedStreak = 0;
  #attached: Promise<void> = Promise.resolve();

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
    // Await the first attach attempt so callers publish into a connected mesh
    // when startup is orderly; later re-elections happen in the background.
    await this.#attached;
  }

  publish(message: InvalidationMessage): void {
    // Local subscribers always hear the precise message (two caches in one
    // process stay coherent even mid-re-election); the wire may degrade.
    this.#dispatch(message);
    const frame = toWireFrame(message);
    if (this.#server) {
      this.#fanOut(frame, null);
      return;
    }
    this.#peer?.write(frame, this.onWriteError);
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
    await this.#teardownRole();
    await this.#supervision;
    this.#handlers.clear();
  }

  async #supervise(): Promise<void> {
    while (!this.#stopped) {
      let resolveAttached!: () => void;
      this.#attached = new Promise((resolve) => (resolveAttached = resolve));
      try {
        // The role's end-signal travels WRAPPED in an object: an async
        // function resolving a bare promise flattens it (this await would
        // then block until the role ENDED and start() would hang).
        const { ended } = await this.#attach();
        resolveAttached();
        if (this.#stopped) {
          // close() ran while the attach was in flight and found no role to
          // tear down — tear down the one that just landed, or it becomes a
          // zombie hub holding the path and close() hangs on `ended` forever.
          await this.#teardownRole();
          return;
        }
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
      const role = await this.#becomeHub();
      this.#refusedStreak = 0;
      return role;
    } catch (error) {
      if (!isAddrInUse(error)) {
        throw error;
      }
      try {
        const role = await this.#becomePeer();
        this.#refusedStreak = 0;
        return role;
      } catch (peerError) {
        // Bind refused AND connect refused: a stale file from a crashed hub —
        // or a live hub that hasn't finished listen() yet. Reclaim only after
        // consecutive refusals, and RETRY the dance instead of binding here.
        this.#refusedStreak += 1;
        if (this.#refusedStreak >= 2) {
          this.#refusedStreak = 0;
          this.#options.onError?.(peerError);
          tryUnlink(this.#options.path);
        }
        throw peerError; // supervise sleeps and re-runs the whole dance
      }
    }
  }

  #becomeHub(): Promise<{ ended: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#onHubConnection(socket));
      server.once('error', reject);
      server.listen(this.#options.path, () => {
        server.removeListener('error', reject);
        // A post-listen server error (EMFILE under fd exhaustion, …) must
        // resign the role for re-election, never crash the process.
        server.on('error', this.onServerError);
        this.#server = server;
        const inode = tryInode(this.#options.path);
        const selfCheck = setInterval(
          () => this.#verifyHubOwnership(server, inode),
          this.#reconnectDelayMs * 5,
        );
        selfCheck.unref?.();
        const ended = new Promise<void>((resolveEnd) => {
          server.once('close', () => {
            clearInterval(selfCheck);
            resolveEnd();
          });
        });
        resolve({ ended });
      });
    });
  }

  /**
   * The stranded-hub defense: if the socket file was unlinked or replaced (a
   * residual reclaim race), this hub is bound to an invisible inode — new
   * peers can never reach it and the partition would otherwise be permanent.
   * Resigning closes the server, which ends the role and re-runs the election.
   */
  #verifyHubOwnership(server: Server, inode: number | null): void {
    if (tryInode(this.#options.path) !== inode) {
      this.#options.onError?.(
        new Error('socket-bus hub lost its socket path; resigning for re-election'),
      );
      server.close();
      this.#server = null;
    }
  }

  #onHubConnection(socket: Socket): void {
    this.#hubConnections.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.#hubConnections.delete(socket));
    readFrames(socket, this.#options.onError, (message) => {
      this.#dispatch(message);
      this.#fanOut(toWireFrame(message), socket);
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
          socket.on('error', () => socket.destroy());
        });
        readFrames(socket, this.#options.onError, (message) =>
          this.#dispatch(message),
        );
        resolve({ ended });
      });
    });
  }

  // TS-private (not #) so the write-failure branch is unit-testable directly —
  // a mid-teardown write error is not deterministically triggerable over a
  // real socket. A failed frame write costs staleness-until-TTL, nothing more.
  private readonly onWriteError = (error?: Error | null): void => {
    if (error) {
      this.#options.onError?.(error);
    }
  };

  // TS-private for the same reason: EMFILE-class post-listen server errors
  // are not deterministically triggerable in a test. Resigning closes the
  // server, which ends the role and re-runs the election.
  private readonly onServerError = (error: unknown): void => {
    this.#options.onError?.(error);
    this.#server?.close();
    this.#server = null;
  };

  /** Hub-side: send a frame to every connection except the origin. */
  #fanOut(frame: string, origin: Socket | null): void {
    for (const connection of this.#hubConnections) {
      if (connection !== origin) {
        connection.write(frame, this.onWriteError);
      }
    }
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

  async #teardownRole(): Promise<void> {
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

/** Serialize for the wire, degrading oversized messages to a full clear. */
function toWireFrame(message: InvalidationMessage): string {
  const frame = JSON.stringify(message) + '\n';
  if (frame.length > MAX_SEND_BYTES) {
    // Colder, never staler: receivers evict everything instead of the frame
    // being destroyed at the receiver and the invalidation never arriving.
    return JSON.stringify({ clear: true }) + '\n';
  }
  return frame;
}

/** Attach an NDJSON frame reader (with a partial-frame size guard) to a socket. */
function readFrames(
  socket: Socket,
  onError: ((error: unknown) => void) | undefined,
  onMessage: (message: InvalidationMessage) => void,
): void {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
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
    // The cap applies to the RESIDUAL (one partial frame) — checking the
    // undrained buffer before splitting would kill a healthy connection
    // delivering a burst of small frames in one chunk.
    if (buffer.length > MAX_FRAME_BYTES) {
      onError?.(new Error('socket-bus frame exceeds the size cap'));
      socket.destroy();
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

function tryInode(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null; // unlinked (or a Windows pipe with no filesystem entry)
  }
}
