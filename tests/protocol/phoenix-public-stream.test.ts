import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { PhoenixPublicStream } from '../../server/protocol/phoenix/public-stream';

class Socket extends EventEmitter {
  send = vi.fn();
  terminate = vi.fn();
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
afterEach(() => vi.useRealTimers());

it('subscribes only to public exchange data and treats frames as invalidations', () => {
  vi.useFakeTimers(); const socket = new Socket(); const invalidate = vi.fn();
  const stream = new PhoenixPublicStream(invalidate, () => socket); stream.start(); socket.emit('open');
  expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'subscribe', subscription: { channel: 'exchange' } });
  expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({ type: 'subscribe', subscription: { channel: 'allMids' } });
  socket.frame({ channel: 'exchange', messageType: 'encodedSnapshot', version: 1, sequenceNumber: '50', payload: 'EXAMPLE' });
  expect(invalidate).toHaveBeenLastCalledWith('update');
  invalidate.mockClear(); socket.frame({ channel: 'exchange', sequenceNumber: '50' });
  expect(invalidate).not.toHaveBeenCalled();
  socket.frame({ channel: 'exchange', sequenceNumber: '52' });
  expect(invalidate.mock.calls.map(c => c[0])).toEqual(['gap', 'update']);
  stream.shutdown(); expect(socket.terminate).toHaveBeenCalledTimes(1);
});

it('accepts ordered complete price maps, ignores duplicates and invalidates malformed prices', () => {
  vi.useFakeTimers(); const socket = new Socket(); const invalidate = vi.fn(); const receive = vi.fn();
  const stream = new PhoenixPublicStream(invalidate, () => socket, receive); stream.start();
  const frame = { channel: 'allMids', slot: 10, slotIndex: 3, mids: { BTC: 42 } };
  socket.frame(frame); socket.frame(frame); socket.frame({ ...frame, slotIndex: 2 });
  expect(receive).toHaveBeenCalledTimes(1); expect(receive).toHaveBeenCalledWith({ BTC: 42 });
  socket.frame({ ...frame, slot: 20 }); expect(receive).toHaveBeenCalledTimes(2);
  receive.mockImplementation(() => { throw new Error('EXAMPLE'); });
  socket.frame({ ...frame, slot: 21, mids: { BTC: 0 } });
  expect(invalidate).toHaveBeenCalledWith('gap'); expect(socket.terminate).toHaveBeenCalledTimes(1);
  stream.shutdown();
});

it('requires a snapshot before deltas, backs off reconnects and bounds silent sockets', async () => {
  vi.useFakeTimers(); const sockets: Socket[] = []; const invalidate = vi.fn();
  const factory = vi.fn(() => { const s = new Socket(); sockets.push(s); return s; });
  const stream = new PhoenixPublicStream(invalidate, factory); stream.start();
  sockets[0].frame({ channel: 'exchange', sequenceNumber: '1' });
  expect(invalidate).toHaveBeenCalledWith('gap'); expect(sockets[0].terminate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_999); expect(factory).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(factory).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(45_000); expect(sockets[1].terminate).toHaveBeenCalledTimes(1);
  stream.shutdown(); await vi.advanceTimersByTimeAsync(120_000); expect(factory).toHaveBeenCalledTimes(2);
});

it.each(['malformed', 'oversize', 'error', 'bad_sequence'])('contains %s frames without parsing compressed data', kind => {
  vi.useFakeTimers(); const socket = new Socket(); const invalidate = vi.fn();
  const stream = new PhoenixPublicStream(invalidate, () => socket); stream.start();
  if (kind === 'malformed') socket.emit('message', Buffer.from('{'));
  if (kind === 'oversize') socket.emit('message', Buffer.alloc(262_145));
  if (kind === 'error') socket.frame({ channel: 'error', error: 'EXAMPLE' });
  if (kind === 'bad_sequence') socket.frame({ channel: 'exchange', sequenceNumber: 1 });
  expect(invalidate).toHaveBeenCalledWith('gap'); expect(socket.terminate).toHaveBeenCalledTimes(1);
  stream.shutdown();
});

it('bounds socket constructor failure without throwing into application startup', async () => {
  vi.useFakeTimers(); const factory = vi.fn(() => { throw new Error('EXAMPLE'); });
  const stream = new PhoenixPublicStream(vi.fn(), factory); expect(() => stream.start()).not.toThrow();
  await vi.advanceTimersByTimeAsync(5_000); expect(factory).toHaveBeenCalledTimes(2);
  stream.shutdown();
});
