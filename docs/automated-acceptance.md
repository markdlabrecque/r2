# Owner-operated automated acceptance

This tool is not evidence that an installed service passed acceptance. Run only on the owner's **non-production** Linux installation, locally in a private interactive terminal. No production, SSH orchestration, auto-resume daemon, or automatic acceptance is provided. Read [private installation](private-installation.md), [host safety](acceptance-host.md), [runner](acceptance-runner.md), [reboot recovery](acceptance-reboot.md), and [journal](acceptance-journal.md) first.

## Prerequisites and safety

Use the supported `/opt/r2` installation and Node 24, npm and its installed dependencies. The inspected installation must match the committed unit and layout in the host documentation. Its `/opt/r2/.r2-revision` must be a root-owned 0644 regular file containing the exact full 40-character Git commit of the installed code. The installation instructions currently require the owner to establish that provenance separately. For a freshly reviewed installation made from a known commit, record that commit as a single line in the file using a root-only editor, then set the file to root ownership and mode 0644. Do not copy the current checkout's revision unless you have verified it is the installed revision. The tool refuses missing or unsupported provenance rather than guessing from a checkout. Review the installation, host identity, revision and non-production status before proceeding.

The designated operator runs the tool as root for access to the private host metadata, fixed registry and opted-in systemd operations. `sudo` must be available and Node 24 and npm must be on its secure PATH. Do not put passwords, cookies or origins in commands or logs. Passwords are read from the terminal without echo and kept in memory; resume asks again. The tool determines the HTTPS origin from local Serve status; TLS verification is never disabled. It never reads `/etc/r2/r2.env` contents.

The registry is `/var/lib/r2-acceptance`, owned by the designated operator, mode 0700. Run directories contain private 0600 journal and JSON/Markdown report files, outside application data and source. Keep them private. Reports contain only bounded evidence, not the private origin or credentials. Synthetic reminders are permanent and can still notify after the tool exits; this tool cannot cancel or delete them. Model requests use real quota. Connecting a browser replaces the previous recipient. Service restarts, temporary model disablement and notification pause can affect the installation and other overdue reminders. The runner asks for fresh stage approvals, not a global yes.

## Commands

From the installed checkout, use a root terminal. `--help` and `--preflight` do not authorize mutations; preflight inspects the host and makes an anonymous HTTPS probe only.

```sh
cd /opt/r2
sudo npm run acceptance -- --help
sudo npm run acceptance -- --preflight
sudo npm run acceptance -- --live --non-production --allow-service-disruption
sudo npm run acceptance -- --resume RUN-ID --non-production --allow-service-disruption
sudo npm run acceptance -- --recover RUN-ID --non-production --allow-service-disruption
sudo npm run acceptance -- --retry RUN-ID --non-production --allow-service-disruption
sudo npm run acceptance -- --export RUN-ID
sudo npm run acceptance -- --reboot RUN-ID --non-production --allow-service-disruption
sudo npm run acceptance -- --reboot-resume RUN-ID --non-production --allow-service-disruption
```

Replace `RUN-ID` with the displayed UUID, not a path. Keep it available privately for recovery. The live mode also accepts `--non-production` without the disruption capability, but the scenarios that need host disruption cannot proceed. For a reboot, first complete the ordinary stages, then explicitly select `--reboot`; acknowledge the exact printed manual resume command and separately approve the reboot. After the host returns, execute that command manually. Same-boot resume is rejected. No reboot is scheduled by ordinary resume. Reboot scheduling uncertainty after a command error needs private owner investigation; do not blindly retry or remove the lock.

Allow at least an hour plus time for device setup, human checks and recovery; each reminder has at least ten minutes lead time. Answer pass only after actual observation. Stock Firefox on the MacBook must show the notification, generic wording and authenticated click-through. Test a second device without reconnecting and separately test an outside-tailnet and an excluded client. Missing devices or unobserved display are blocked, not pass. Provider acceptance is not desktop display. Reports preserve automated and owner-reported evidence separately.

On cancellation, error, SIGINT or SIGTERM, follow prompts for restoration and inspect the report. SIGKILL or power loss cannot run cleanup: use the same run ID with `--recover`; reboot checkpoints require `--reboot-resume` after the verified new boot. Recovery may require fresh approval and credentials. If Serve is unavailable, recovery can still attempt owned host restoration without sending credentials or network requests, but API verification remains failed until private HTTPS is restored and recovery is repeated. An interrupted stage never restarts automatically. After recovery, `--retry` requests separate approval to make that stage eligible for a later `--resume`; it can result in another permanent reminder. An unresolved cleanup retains the host lock; preserve conflicting files and follow the fixed recovery instructions in the report and host documentation. Never delete an uncertain lock or ownership gate based on age. If a gate remains after a crash, stop all acceptance processes and manually reconcile it as described in the journal documentation.

Tests use synthetic inputs; they do not prove a real notification, provider, tailnet policy or reboot. Owner evidence remains a separate, deliberate activity.
