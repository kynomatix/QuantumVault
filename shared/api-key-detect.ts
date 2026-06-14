// Pasted-secret guard — shared by the Lab Assistant chat client and server.
//
// An OpenRouter API key (sk-or-...) — or any long sk-* secret — must NEVER be
// typed into the assistant chat, stored as a chat message, or sent in a model
// prompt. Keys belong ONLY in the encrypted keystore (Creator → "Add API key",
// which POSTs to /api/lab/creator/key and encrypts under the user's UMK).
//
// The chat client blocks a matching draft before it leaves the browser, and the
// chat route rejects matching content BEFORE it is persisted (defense in depth).
//
// Intentionally broad: any `sk-` token followed by a long key-like tail. Real
// chat prose effectively never trips this (a bare "sk-" or short token won't).

const LIKELY_API_KEY_RE = /\bsk-[a-z0-9_-]{16,}/i;

/** True when the text appears to contain a pasted secret API key. */
export function looksLikeApiKey(text: string | null | undefined): boolean {
  if (!text) return false;
  return LIKELY_API_KEY_RE.test(text);
}
