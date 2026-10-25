// Bounded requests include response parsing. Foreground callers own controls;
// background meanings/voices use a small cancellable task notice.
export function friendlyError(error) {
  if (error?.code === 'cancelled') return 'Cancelled. You can try again when you’re ready.';
  if (error?.code === 'timeout' || error?.name === 'TimeoutError') return 'This took too long. Check your connection and try again.';
  if (error?.status === 401) return 'Your OpenAI key was rejected. Check it in Settings.';
  if (error?.code === 'insufficient_quota') return 'Your OpenAI account has no available credit. Check its billing settings.';
  if (error?.status === 429) return 'OpenAI is receiving too many requests. Wait a moment, then try again.';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'You’re offline. Reconnect and try again.';
  if (error instanceof SyntaxError) return 'We couldn’t read the response. Please try again.';
  if (error instanceof TypeError) return 'We couldn’t connect. Check your connection and try again.';
  return error?.message || 'Something went wrong. Please try again.';
}
export async function requestAI(url, options, { signal, timeoutMs = 40000, audio = false, label, retry } = {}) {
  const controller = new AbortController();
  const task = label ? requestNotice(label, () => controller.abort(), retry) : null;
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
    const data = audio ? await response.arrayBuffer() : await response.json();
    task?.remove(); return data;
  } catch (error) {
    if (controller.signal.aborted) {
      const cancelled = Object.assign(new Error(), { name: 'AbortError', code: timedOut ? 'timeout' : 'cancelled' });
      cancelled.message = friendlyError(cancelled);
      task?.failed(cancelled.message);
      throw cancelled;
    }
    task?.failed(friendlyError(error));
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}

function requestNotice(label, cancel, retry) {
  if (typeof document === 'undefined') return null;
  let area = document.getElementById('ai-requests');
  if (!area) { area=document.createElement('section');area.id='ai-requests';area.setAttribute('aria-label','AI requests');document.body.append(area); }
  const row=document.createElement('div');row.className='ai-request';
  const text=document.createElement('span');text.textContent=label+'…';text.setAttribute('role','status');
  const button=document.createElement('button');button.textContent='Cancel';button.onclick=cancel;row.append(text,button);area.append(row);
  return { remove:()=>row.remove(), failed:message=>{text.textContent=label+': '+message;button.textContent='Dismiss';button.onclick=()=>row.remove();if(retry){const again=document.createElement('button');again.textContent='Retry';again.onclick=()=>{row.remove();retry()};row.append(again)}} };
}
