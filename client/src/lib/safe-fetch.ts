/**
 * Safely parse the body of a fetch Response as JSON.
 *
 * With no signal: exact existing behaviour — benign on empty body, benign on
 * malformed JSON for error responses, throws on malformed JSON for 2xx.
 *
 * With a signal: the body read races the signal so a never-settling body
 * stream doesn't hold the caller forever. When the signal fires:
 *  - the listener is removed in a finally block (no leak)
 *  - the abandoned body promise is suppressed (no unhandled-rejection)
 *  - the response body stream is best-effort cancelled
 *  - the abort reason / DOMException is rethrown as-is, never converted to
 *    a normal error-shape object (callers distinguish cancellation from parse
 *    errors by catching DOMException / AbortError)
 */
export async function safeResponseJson(res: Response, signal?: AbortSignal): Promise<any> {
  let text: string | undefined;
  let textPromise: Promise<string> | undefined;

  try {
    // Early abort guard — don't even start the read if already cancelled.
    if (signal?.aborted) {
      try { res.body?.cancel(); } catch { /* best-effort */ }
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    textPromise = res.text();

    if (signal) {
      let abortListener: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        abortListener = () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      });

      try {
        text = await Promise.race([textPromise, abortPromise]);
      } finally {
        // Always remove the listener to prevent leaks.
        if (abortListener) signal.removeEventListener("abort", abortListener);
        // Suppress any future rejection from the abandoned body read.
        textPromise.catch(() => {});
        // Best-effort cancel the body stream if the signal won the race.
        if (signal.aborted) {
          try { res.body?.cancel(); } catch { /* best-effort */ }
        }
      }
    } else {
      text = await textPromise;
    }

    if (!text) {
      if (!res.ok) {
        return {
          error: `Server error (${res.status}), please try again`,
          _rawStatus: res.status,
        };
      }
      return {};
    }
    return JSON.parse(text);
  } catch (err) {
    // Abort / cancellation: rethrow as-is, never convert to an error-shape
    // object. Callers that need to distinguish abort from parse errors check
    // instanceof DOMException or err.name === "AbortError" / "TimeoutError".
    if (
      err instanceof DOMException ||
      (err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError"))
    ) {
      // Belt-and-suspenders: ensure abandoned body promise is suppressed
      // even if the early-abort path skipped textPromise creation.
      textPromise?.catch(() => {});
      throw err;
    }
    // Malformed JSON or other read error.
    if (res.ok) {
      throw new Error("Server returned an invalid response, please try again");
    }
    const rawSnippet =
      text && text.length > 200 ? text.slice(0, 200) : text;
    return {
      error:
        rawSnippet && !rawSnippet.startsWith("<!") ?
          rawSnippet :
          "Server temporarily unavailable, please try again",
      _rawStatus: res.status,
    };
  }
}
