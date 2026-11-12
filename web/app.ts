// Web shell entrypoint. Chat, login and notification setup arrive in later tasks.
// Nothing here reports success: it only checks that the service answers.
const status = document.getElementById('status');

async function checkService(): Promise<void> {
  if (status === null) return;
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    status.textContent = res.ok
      ? 'The service is running, but setup is not yet implemented. Sign-in and reminders are not available.'
      : 'The service is not healthy. Setup is not yet implemented.';
  } catch {
    status.textContent = 'The service cannot be reached. Setup is not yet implemented.';
  }
}

void checkService();
