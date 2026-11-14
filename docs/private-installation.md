# Private test-host installation

This is an owner-operated installation on a non-production Linux host with systemd, Node.js 24, npm, build tools for native SQLite, and Tailscale installed. No deployment is performed by this repository. Commands below assume an owner-controlled, reviewed checkout and sudo access. They use `/opt/r2` for code, `/var/lib/r2` for persistent state, and `/etc/r2/r2.env` for configuration. The service account cannot modify the installed code or read the environment file directly; systemd supplies its contents to the process. Root and privileged host administrators can still read process environment and data. Restrict host access accordingly.

## Prepare and configure

1. Install and authenticate Tailscale on the test host. Enable MagicDNS and HTTPS certificates for your tailnet in the Tailscale admin console. Configure and verify tailnet grants/ACLs so only the owner's intended devices can reach the host's HTTPS port. Review existing Serve and Funnel configuration; do not enable Funnel or expose a public listener. Consult the current Tailscale documentation for your version and policy syntax.
2. For a fresh installation only, from the reviewed checkout install a clean copy of the **committed** files (including this document's `deploy/` directory). The commands below overwrite an existing configuration and must not be rerun for an upgrade. This example installs the current commit, not uncommitted changes. Do not copy `.sandcastle/.env`, local credentials, or a database into the code directory:

   ```sh
   sudo groupadd --system r2
   sudo useradd --system --gid r2 --home-dir /var/lib/r2 --no-create-home --shell /usr/sbin/nologin r2
   sudo install -d -o root -g root -m 0755 /opt/r2
   git archive HEAD | sudo tar -x -C /opt/r2
   cd /opt/r2
   sudo npm ci
   sudo npm run build
   sudo chown -R root:root /opt/r2
   sudo chmod -R go-w /opt/r2
   sudo install -d -o r2 -g r2 -m 0700 /var/lib/r2
   sudo install -d -o root -g root -m 0700 /etc/r2
   sudo install -o root -g root -m 0600 deploy/r2.env.example /etc/r2/r2.env
   ```

   For upgrades stop the service first, install a clean reviewed build and dependencies, and retain `/var/lib/r2` and `/etc/r2/r2.env`. This unreleased build refuses incompatible databases; do not delete or replace one to make startup succeed. Assess compatibility and protect the data before upgrading. No automated backup or restore is provided.
3. Create a strong owner password hash interactively with `npm run hash-password`; input is hidden. Transfer the resulting PHC hash into `/etc/r2/r2.env` with a root-only editor. Generate a VAPID key pair on the host with `./node_modules/.bin/web-push generate-vapid-keys` and transfer both keys into that file. These commands display sensitive output: use a private terminal, do not record it, and clear terminal scrollback. Keep the same VAPID pair across restarts; replacing it requires reconnecting the browser. Set `VAPID_SUBJECT` to an appropriate `mailto:` contact or HTTPS URL. Set `OPENAI_API_KEY` and `OPENAI_MODEL` for chat. Do not place passwords or keys in shell commands, shell history, screenshots, logs, or Git. Protect editor temporary files too.
4. Edit `R2_ORIGIN` to exactly `https://<host>.<tailnet>.ts.net` (the HTTPS name assigned to this host, no trailing slash, path, or default port). Leave `R2_DATA_DIR=/var/lib/r2` and `R2_PORT=3000` unless you adapt both the unit and Serve configuration. The file uses systemd EnvironmentFile syntax, not shell syntax: use literal `NAME=value` lines; do not use `export` or shell substitution. In particular, keep the `$` characters of the password hash literal. Environment files are not a secret vault; limit privileged access. Missing password disables login; missing VAPID disables push; missing OpenAI disables chat, but saved reminders can still send.

## Enable the service and private HTTPS

The supplied unit assumes Node at `/usr/bin/node`; verify with `command -v node` and change `ExecStart` if necessary. If paths change, update `WorkingDirectory`, `EnvironmentFile`, `ReadWritePaths`, and the configuration together. The service uses a dedicated unprivileged account, a private umask, read-only system paths and a writable data directory. SQLite and its WAL files remain in `/var/lib/r2`.

```sh
sudo install -o root -g root -m 0644 /opt/r2/deploy/r2.service /etc/systemd/system/r2.service
sudo systemctl daemon-reload
sudo systemctl enable --now r2.service
sudo systemctl status r2.service
curl --fail http://127.0.0.1:3000/healthz
```

R2 listens only on `127.0.0.1`; `/healthz` returns generic status, not feature readiness. A successful response does not prove login, push, or OpenAI works. Configure Tailscale Serve on the host (the command syntax is for current Tailscale; check `tailscale serve --help` on your version):

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status
```

Confirm status shows **Serve**, HTTPS and the loopback upstream, not Funnel. Open the exact `R2_ORIGIN` from an authorized tailnet device; verify TLS, sign in, explicitly choose an IANA timezone in the app, connect the single notification browser, and send a test notification. Other authorized devices may use chat but connecting a new notification browser replaces the old one. Verify from an unauthorized device and from outside the tailnet that access is denied. Tailnet membership alone is not owner authentication: retain the password login and enforce tailnet access policy. Do not port-forward 3000 or publish Serve via Funnel.

## Operations and acceptance limits

- `sudo systemctl restart r2` applies configuration changes. `sudo systemctl stop r2` stops delivery without deleting data; starting again sends overdue reminders. Pause via the app or `R2_PAUSE_NOTIFICATIONS=true` and restart; resume to send overdue reminders. The environment pause overrides the app control.
- `sudo journalctl -u r2.service` shows operational logs. Treat logs as private, restrict journal access and retention, and never paste secrets or reminder text into evidence. Authentication, push and model readiness appear in the signed-in app; investigate a failed unit with systemd status and private logs.
- R2 sends current reminder requests, current time and timezone to OpenAI for interpretation. Push providers receive only an opaque ID; displayed notifications are generic. Provider acceptance is not proof of display. Database files contain private reminders and subscription data: protect the whole directory including WAL/SHM.
- Owner acceptance remains a separate manual gate: on a real private Tailscale test host, use Firefox to create and confirm a reminder, restart before it is due, disable OpenAI, close the tab, and observe the generic notification and authenticated original due time/provider outcome. Record host isolation, restart and browser results without secrets. Automated mocks or this installation guide do not establish real delivery or Tailscale isolation.
