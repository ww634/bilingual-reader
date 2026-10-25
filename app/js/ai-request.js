// One bounded request, including response parsing. Callers own their Cancel UI.
export function friendlyError(error) {
  if (error?.code === 'cancelled') return 'Cancelled. You can try again when you’re ready.';
  if (error?.code === 'timeout' || error?.name === 'TimeoutError') return 'This took too long. Check your connection and try again.';
  if (error?.status === 401) return 'Your OpenAI key was rejected. Check it in Settings.';
  if (error?.code === 'insufficient_quota') return 'Your OpenAI account has no available credit. Check its billing settings.';
  if (error?.status === 429) return 'OpenAI is receiving too many requests. Wait a moment, then try again.';
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'You’re offline. Reconnect and try again.';
  if (error instanceof TypeError) return 'We couldn’t connect. Check your connection and try again.';
  return error?.message || 'Something went wrong. Please try again.';
}
export async function requestAI(url, options, { signal, timeoutMs = 40000, audio = false } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = Object.assign(new Error('The request could not be completed. Please try again.'), { status: response.status, code: data.error?.code });
      error.message = friendlyError(error); throw error;
    }
    return audio ? await response.arrayBuffer() : await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      const cancelled = Object.assign(new Error(), { name: 'AbortError', code: timedOut ? 'timeout' : 'cancelled' });
      cancelled.message = friendlyError(cancelled); throw cancelled;
    }
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}
