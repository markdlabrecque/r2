// Web shell: owner sign-in, explicit timezone and sign-out. Chat and notifications arrive in later tasks.
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
  const list = $('timezones');
  if (list.childElementCount === 0 && typeof Intl.supportedValuesOf === 'function') {
    for (const name of Intl.supportedValuesOf('timeZone')) {
      const option = document.createElement('option');
      option.value = name;
      list.append(option);
    }
  }
}

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

$('logout').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/session');
  } finally {
    await refresh();
  }
});

void refresh();
