import { deriveSubkey, SUBKEY_PURPOSES, buildAAD, decryptBuffer, zeroizeBuffer } from '../crypto-v3';

export function decryptAgentKeyV3(
  umk: Buffer,
  encryptedV3: string,
  walletAddress: string
): Buffer {
  const privkeySubkey = deriveSubkey(umk, SUBKEY_PURPOSES.AGENT_PRIVKEY);
  try {
    const aad = buildAAD(walletAddress, 'AGENT_PRIVKEY');
    const ciphertext = Buffer.from(encryptedV3, 'base64');
    return decryptBuffer(ciphertext, privkeySubkey, aad);
  } finally {
    zeroizeBuffer(privkeySubkey);
  }
}
