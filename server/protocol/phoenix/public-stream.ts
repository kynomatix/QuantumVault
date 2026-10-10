import WebSocket from 'ws';

interface PublicSocket {
  on(event: string, listener: (...args: any[]) => void): this;
  send(data: string): void;
  terminate(): void;
}
type Invalidation = 'update' | 'gap' | 'disconnect' | 'reconnect';
export type PhoenixSocketFactory = () => PublicSocket;

/**
 * Public exchange WS is an invalidation feed, never a second source of authority.
 * Phoenix publishes encoded (base64+zstd) snapshots. U01 deliberately does not
 * decode them or guess delta schemas: bounded REST snapshots repair every update.
 * The subscription/envelope was verified by an unsigned public WS read.
 */
export class PhoenixPublicStream {
  private socket: PublicSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private backoffMs = 5_000;
  private sequence: bigint | null = null;
  private midsPosition: [number, number] | null = null;

  constructor(
    private readonly invalidate: (event: Invalidation) => void,
    private readonly factory: PhoenixSocketFactory = () => new WebSocket('wss://perp-api.phoenix.trade/v1/ws', {
      maxPayload: 262_144, perMessageDeflate: false, handshakeTimeout: 5_000,
    }),
    private readonly receiveMids: (mids: unknown) => void = () => {},
  ) {}

  start(): void { if (this.stopped) { this.stopped = false; this.connect(); } }

  private connect(): void {
    if (this.stopped) return;
    this.sequence = null;
    this.midsPosition = null;
    this.invalidate('reconnect');
    let socket: PublicSocket;
    try { socket = this.factory(); } catch { this.schedule(); return; }
    this.socket = socket;
    const fail = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.watchdog) clearTimeout(this.watchdog);
      this.invalidate('disconnect');
      socket.terminate();
      this.schedule();
    };
    const armWatchdog = () => {
      if (this.socket !== socket) return;
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = setTimeout(fail, 45_000);
      this.watchdog.unref?.();
    };
    armWatchdog();
    socket.on('open', () => {
      if (this.socket !== socket) return;
      try {
        for (const channel of ['exchange', 'allMids']) socket.send(JSON.stringify({ type: 'subscribe', subscription: { channel } }));
      }
      catch { fail(); }
    });
    socket.on('ping', armWatchdog);
    socket.on('message', (bytes: Buffer) => {
      if (this.socket !== socket) return;
      try {
        if (bytes.byteLength > 262_144) throw new Error('Oversize frame');
        const frame = JSON.parse(bytes.toString());
        if (frame.channel === 'error') throw new Error('Stream refused');
        if (frame.channel === 'allMids') {
          if (!Number.isSafeInteger(frame.slot) || frame.slot < 0 || !Number.isSafeInteger(frame.slotIndex) || frame.slotIndex < 0) throw new Error('Missing price position');
          const previous = this.midsPosition;
          if (previous && (frame.slot < previous[0] || (frame.slot === previous[0] && frame.slotIndex <= previous[1]))) return;
          // allMids is a complete map, not a delta. Slot jumps do not imply missing prices.
          this.receiveMids(frame.mids);
          this.midsPosition = [frame.slot, frame.slotIndex];
          this.backoffMs = 5_000;
          armWatchdog();
          return;
        }
        if (frame.channel !== 'exchange') return;
        if (typeof frame.sequenceNumber !== 'string' || !/^\d{1,30}$/.test(frame.sequenceNumber)) throw new Error('Missing sequence');
        const sequence = BigInt(frame.sequenceNumber);
        const snapshot = frame.messageType === 'encodedSnapshot' && frame.version === 1;
        if (this.sequence === null && !snapshot) { this.invalidate('gap'); fail(); return; }
        if (this.sequence !== null && sequence <= this.sequence) return;
        if (this.sequence !== null && sequence !== this.sequence + 1n) this.invalidate('gap');
        this.sequence = sequence;
        this.backoffMs = 5_000;
        this.invalidate('update');
        armWatchdog();
      } catch { this.invalidate('gap'); fail(); }
    });
    socket.on('close', fail);
    socket.on('error', fail);
  }

  private schedule(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, this.backoffMs);
    this.retry.unref?.();
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
  }

  shutdown(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }
}
