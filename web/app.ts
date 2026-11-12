// Web shell: owner sign-in, explicit timezone, chat with explicit confirmation, reminder list, sign-out.
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Missing element #${id}`);
  return el as T;
};

interface ApiError {
  status: number;
  message: string;
}

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw { status: 0, message: 'The service cannot be reached.' } satisfies ApiError;
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    throw { status: res.status, message: data.error?.message ?? 'The request failed.' } satisfies ApiError;
  }
  return data as T;
}

const messageOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'message' in error ? String((error as ApiError).message) : 'Something went wrong.';

interface Settings {
  timezone: string | null;
  notificationsPaused: boolean;
}

function showSignedOut(loginAvailable: boolean): void {
  $('owner').hidden = true;
  $('login').hidden = !loginAvailable;
  $('status').textContent = loginAvailable
    ? 'Sign in to continue.'
    : 'Owner sign-in is not configured on the server. Set R2_PASSWORD_HASH and restart.';
}

async function showOwner(): Promise<void> {
  const settings = await api<Settings>('GET', '/api/settings');
  $('login').hidden = true;
  $('owner').hidden = false;
  $<HTMLInputElement>('timezone').value = settings.timezone ?? '';
  $('status').textContent =
    settings.timezone === null ? 'Choose your timezone before creating reminders.' : `Signed in. Timezone: ${settings.timezone}.`;
  await loadReminders().catch((e: unknown) => {
    $('confirm-status').textContent = messageOf(e);
  });
  await refreshPush().catch((e: unknown) => {
    $('push-state').textContent = messageOf(e);
  });
  const list = $('timezones');
  if (list.childElementCount === 0 && typeof Intl.supportedValuesOf === 'function') {
    for (const name of Intl.supportedValuesOf('timeZone')) {
      const option = document.createElement('option');
      option.value = name;
      list.append(option);
    }
  }
}

interface Proposal {
  id: string;
  text: string;
  dueAt: string;
  timezone: string;
  localDateTime: string;
}

interface ChatReply {
  type: 'clarify' | 'unsupported' | 'proposal';
  message: string;
  proposal?: Proposal;
  utcOffset?: string;
}

interface ReminderItem {
  id: string;
  text: string;
  dueAt: string;
  timezone: string;
  localDateTime: string;
  state: string;
  attempts: number;
  acceptedAt: string | null;
  errorCode: string | null;
  deliveryAttempts: { attemptNumber: number; outcome: string; errorCode: string | null }[];
}

let pending: { proposal: Proposal; requestId: string } | undefined;

const newRequestId = (): string => crypto.randomUUID();

function showProposal(proposal: Proposal | undefined, utcOffset = ''): void {
  $('proposal').hidden = proposal === undefined;
  if (proposal === undefined) {
    pending = undefined;
    return;
  }
  // One request id per proposal: a retried confirmation cannot create a second reminder.
  pending = { proposal, requestId: newRequestId() };
  $('proposal-text').textContent = proposal.text;
  $('proposal-when').textContent = `${proposal.localDateTime.replace('T', ' ')} ${proposal.timezone}${utcOffset === '' ? '' : ` (UTC${utcOffset})`} · one time only`;
}

const STATE_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  sending: 'Sending',
  retry: 'Retrying',
  accepted: 'Push service accepted (does not prove you saw it)',
  failed: 'Not sent',
};

async function loadReminders(): Promise<void> {
  const { reminders } = await api<{ reminders: ReminderItem[] }>('GET', '/api/reminders');
  const list = $('reminders');
  list.replaceChildren();
  if (reminders.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No reminders yet.';
    list.append(li);
  }
  for (const r of reminders) {
    const li = document.createElement('li');
    const outcome = r.deliveryAttempts.at(-1)?.outcome;
    const parts = [
      r.text,
      `due ${r.localDateTime.replace('T', ' ')} ${r.timezone}`,
      STATE_LABELS[r.state] ?? r.state,
      ...(r.errorCode === null ? [] : [`reason: ${r.errorCode}`]),
      ...(outcome === undefined ? [] : [`attempts: ${r.attempts}, last outcome: ${outcome}`]),
    ];
    li.textContent = parts.join(' · ');
    list.append(li);
  }
}
interface PushStatus {
  configured: boolean;
  publicKey: string | null;
  notificationsPaused: boolean;
  subscription: { connected: boolean; ready: boolean; version: number | null };
}

const pushSupported = (): boolean =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function refreshPush(): Promise<void> {
  const state = $('push-state');
  const connect = $<HTMLButtonElement>('push-connect');
  const test = $<HTMLButtonElement>('push-test');
  test.hidden = true;
  const status = await api<PushStatus>('GET', '/api/push');
  if (!status.configured) {
    connect.disabled = true;
    state.textContent = 'Web Push is not configured on the server.';
    return;
  }
  if (!pushSupported()) {
    connect.disabled = true;
    state.textContent = 'This browser cannot receive push notifications.';
    return;
  }
  connect.disabled = false;
  const permission = Notification.permission;
  const paused = status.notificationsPaused ? ' Notifications are paused.' : '';
  if (permission === 'denied') {
    state.textContent = 'Notifications are blocked for this site in the browser settings.';
  } else if (!status.subscription.connected) {
    state.textContent = `No browser is connected.${paused}`;
  } else if (!status.subscription.ready) {
    state.textContent = `A browser is connected but has not passed a test notification yet.${paused}`;
    test.hidden = false;
  } else {
    state.textContent = `A browser is connected and passed its test.${paused}`;
    test.hidden = false;
  }
}

async function connectBrowser(): Promise<void> {
  const status = await api<PushStatus>('GET', '/api/push');
  if (status.publicKey === null) throw { status: 503, message: 'Web Push is not configured on the server.' } satisfies ApiError;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw { status: 0, message: 'Notification permission was not granted.' } satisfies ApiError;
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  // A subscription made with another server key cannot be reused.
  if (existing !== null) await existing.unsubscribe();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(status.publicKey),
  });
  await api('PUT', '/api/push/subscription', subscription.toJSON());
}

const PUSH_FAILURES: Record<string, string> = {
  subscription_gone: 'The push service no longer accepts this browser. Connect it again.',
  rejected: 'The push service rejected the notification.',
  temporary: 'The push service is temporarily unavailable. Try again shortly.',
  network: 'The push service could not be reached. Try again shortly.',
  replaced: 'Another browser was connected meanwhile. Connect this one again.',
};

$('push-connect').addEventListener('click', async () => {
  const error = $('push-error');
  error.textContent = '';
  try {
    await connectBrowser();
    await refreshPush();
  } catch (e) {
    error.textContent = messageOf(e);
    if ((e as ApiError).status === 401) await refresh();
  }
});

$('push-test').addEventListener('click', async () => {
  const error = $('push-error');
  error.textContent = '';
  try {
    const result = await api<{ ok: boolean; code: string | null }>('POST', '/api/push/test');
    error.textContent = result.ok ? '' : (PUSH_FAILURES[result.code ?? ''] ?? 'The test notification failed.');
    if (result.ok) $('push-state').textContent = 'Test notification sent. Check that this browser displayed it.';
    else await refreshPush();
  } catch (e) {
    error.textContent = messageOf(e);
  }
});

async function refresh(): Promise<void> {
  try {
    const session = await api<{ authenticated: boolean; loginAvailable: boolean }>('GET', '/api/session');
    if (session.authenticated) await showOwner();
    else showSignedOut(session.loginAvailable);
  } catch (error) {
    $('status').textContent = messageOf(error);
  }
}

$('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $<HTMLInputElement>('password');
  const error = $('login-error');
  error.textContent = '';
  try {
    await api('POST', '/api/session', { password: password.value });
    password.value = '';
    await refresh();
  } catch (e) {
    password.value = '';
    error.textContent = messageOf(e);
  }
});

$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('settings-status');
  status.textContent = '';
  try {
    const saved = await api<Settings>('PUT', '/api/settings', { timezone: $<HTMLInputElement>('timezone').value.trim() });
    $<HTMLInputElement>('timezone').value = saved.timezone ?? '';
    status.textContent = `Timezone saved: ${saved.timezone}.`;
    $('status').textContent = `Signed in. Timezone: ${saved.timezone}.`;
  } catch (e) {
    status.textContent = messageOf(e);
    if ((e as ApiError).status === 401) await refresh();
  }
});

$('chat').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>('message');
  const reply = $('reply');
  $('confirm-status').textContent = '';
  showProposal(undefined);
  reply.textContent = 'Thinking…';
  try {
    const result = await api<ChatReply>('POST', '/api/chat', { message: input.value });
    reply.textContent = result.message;
    if (result.type === 'proposal') showProposal(result.proposal, result.utcOffset);
    input.value = '';
  } catch (e) {
    reply.textContent = messageOf(e);
    if ((e as ApiError).status === 401) await refresh();
  }
});

$('confirm').addEventListener('click', async () => {
  if (pending === undefined) return;
  const status = $('confirm-status');
  status.textContent = 'Saving…';
  try {
    await api('POST', '/api/reminders/confirm', { proposalId: pending.proposal.id, requestId: pending.requestId });
    showProposal(undefined);
    $('reply').textContent = '';
    status.textContent = 'Saved. The reminder is stored and will be sent when due.';
    await loadReminders();
  } catch (e) {
    // Keep the proposal and request id so Save can be pressed again safely.
    status.textContent = `${messageOf(e)} Nothing is confirmed until this says Saved.`;
  }
});

$('discard').addEventListener('click', () => {
  showProposal(undefined);
  $('reply').textContent = '';
  $('confirm-status').textContent = 'Discarded. Nothing was saved.';
});

$('logout').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/session');
  } finally {
    await refresh();
  }
});

void refresh();
