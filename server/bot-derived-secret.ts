import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import nacl from 'tweetnacl';

/** Same version-1 path as session-v3. Caller MUST clear the returned secret.
 * JS mnemonic/hex strings cannot be zeroized; keep them inside this synchronous scope.
 */
export function deriveBotSecretKeyFromAgentSeed(mnemonic: Buffer, index: number, version = 1): Uint8Array {
  if (!Number.isInteger(index) || index < 1 || index > 2147483647) throw new Error('Invalid botIndex');
  if (version !== 1) throw new Error('Unsupported bot derivation path version');
  const phrase = mnemonic.toString('utf8');
  if (!bip39.validateMnemonic(phrase)) throw new Error('Invalid mnemonic');
  const seed = bip39.mnemonicToSeedSync(phrase);
  let derived: Buffer | undefined;
  try {
    derived = derivePath(`m/44'/501'/${index}'/0'`, seed.toString('hex')).key;
    if (derived.length !== 32) throw new Error('Derived seed must be exactly 32 bytes');
    return nacl.sign.keyPair.fromSeed(derived).secretKey;
  } finally { seed.fill(0); derived?.fill(0); }
}
