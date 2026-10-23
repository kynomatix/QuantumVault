export function getServerExecutionKey(): Buffer {
  const keyHex = process.env.SERVER_EXECUTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('SERVER_EXECUTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

