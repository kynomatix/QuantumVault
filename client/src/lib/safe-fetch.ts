export async function safeResponseJson(res: Response): Promise<any> {
  let text: string | undefined;
  try {
    text = await res.text();
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
  } catch {
    if (res.ok) {
      throw new Error('Server returned an invalid response, please try again');
    }
    const rawSnippet = text && text.length > 200 ? text.slice(0, 200) : text;
    return {
      error: rawSnippet && !rawSnippet.startsWith('<!') ? rawSnippet : 'Server temporarily unavailable, please try again',
      _rawStatus: res.status,
    };
  }
}
