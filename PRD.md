# Self-hosted personal agent

## Status

Rough product blueprint for discussion. This document defines the first version, not a detailed implementation plan.

## Product goal

Build a persistent personal agent, in the spirit of Grokbot and OpenAI's Dot, that remembers useful context and follows through on dates and reminders. These products are inspiration, not specifications to copy.

The owner runs the agent on their own always-on server or VPS. The agent serves one person. Hosted LLM APIs are allowed, so self-hosting does not necessarily keep all data on the server.

## First-version decisions

- Memories live in a folder structure of Markdown documents.
- The agent runs unattended, manages its memories and schedules, and recovers after restarts.
- Self-management does not include modifying its code, installing tools, changing permissions, or deploying updates.
- The conversation and notification channels remain undecided.
- Additional MCP integrations are allowed in the future, but none are part of this version.

## User outcomes

- Tell the agent something once and have it recall that information in a later conversation.
- Inspect, correct, export, or delete saved memories without depending on an opaque memory service.
- Record birthdays, anniversaries, and other important dates.
- Set, inspect, change, snooze, and cancel reminders through conversation.
- Receive due notifications without keeping a chat session open.
- Restart or upgrade the service without losing memories or pending reminders.

## Scope and requirements

### Conversation and continuity

The agent accepts natural-language requests through one initial channel, selected before implementation. Conversation transport stays separate from agent logic so a later channel does not require a rewrite.

Each response can use relevant memories and recent conversation context. The agent must distinguish saved facts from guesses and ask when a request lacks information needed to act.

Conversation history and durable memory are separate. Saving a transcript does not automatically make every statement a permanent fact. The history retention policy remains an open decision.

### Memory skills

Provide skills to save, find, update, and forget memories.

- Save explicit requests such as "Remember that I prefer morning appointments."
- Propose useful facts for retention. For the first version, require approval before saving an inferred memory.
- Retrieve relevant documents when answering a question, rather than loading the entire archive into every prompt.
- Identify the saved document when the user asks where a remembered fact came from.
- Handle corrections without silently retaining contradictory facts as equally current.
- Keep files readable and editable by the owner. Detect external edits and refresh any derived index.
- Treat document text as data, not as permission to run instructions or expand tool access.

Suggested structure, subject to refinement:

```text
memory/
  profile.md
  preferences.md
  people/
    person-name.md
  projects/
    project-name.md
  notes/
    topic.md
```

Use small documents with lightweight metadata, such as a stable ID, last-updated time, and source reference. The exact metadata format is undecided. Markdown is the source of truth; any search index must be rebuildable from it. Start with file and text search. Add semantic search only if recall tests show a need.

### Important-date skills

Provide skills to record, list, update, and remove important dates.

An important date is a calendar fact, such as a birthday. A reminder is an instruction to notify the user. Recording a date must not silently create notifications without an agreed default or an explicit request.

Support one-off dates and annual dates in the first version. Allow dates with an unknown year. Define handling for leap-day anniversaries before implementation. Important dates use calendar dates, not midnight UTC timestamps.

### Reminder skills

Provide skills to create, list, update, cancel, and snooze reminders. Support one-off reminders and simple daily, weekly, and annual recurrence. Defer arbitrary recurrence expressions.

- Resolve natural-language times against the user's configured timezone.
- Ask for clarification when a date, time, or timezone is ambiguous.
- Confirm the actual date, time, timezone, and recurrence after saving.
- Report success only after the schedule is durably stored.
- Persist pending reminders independently of the conversation and model context.
- Deliver notifications through the selected channel and record delivery attempts.
- Retry temporary failures with bounded backoff and expose permanent failures.
- Recheck the current schedule before dispatch so canceled or changed reminders do not use stale jobs.

A deterministic scheduler decides when reminders are due. The LLM interprets requests and can compose messages, but it is not the clock. Previously saved reminders must remain deliverable during an LLM outage.

Proposed downtime policy: deliver overdue one-off reminders after recovery, with their original due time. For recurring reminders, send at most one catch-up notification and schedule the next future occurrence. Confirm this policy before implementation.

Prevent duplicate dispatch where possible. Do not promise exactly-once delivery when a notification provider cannot support it. Distinguish provider acceptance from proof that the user saw a message.

### Unattended operation

The service starts automatically after host restart and resumes pending work. It sleeps between requests and scheduled jobs rather than running a continuous LLM loop.

Provide health status, useful error logs, and a record of memory changes and reminder actions. Avoid logging secrets or full private conversations by default. Bound model calls, retries, and spending; surface failures rather than retrying forever.

Back up the memory folder and database together. Document and test restore. The owner must be able to pause notifications and stop the agent without deleting its data.

## Proposed architecture

```text
Conversation channel
        |
Agent runtime + LLM provider
        |
Validated skill operations
        |                     |
Markdown memory store    SQLite database
                              |
                      Scheduler + delivery worker
                              |
                      Notification channel
```

Start with one application, persistent local storage, and a process supervisor or container restart policy. The scheduler and notification worker can run within the same application. There is no initial need for distributed workers or a separate queue service.

Skills define allowed operations. Application code validates inputs and performs writes. The model does not receive unrestricted filesystem or database access. The specific agent framework, language, and deployment packaging remain undecided.

### Storage recommendation

Use SQLite for important dates, reminders, delivery attempts, and minimal runtime state. It supports transactions and restart recovery without another database service to operate. This is a proposal, not a final schema decision.

Keep these records distinct:

| Record | Purpose |
| --- | --- |
| Important date | Calendar fact, recurrence, associated person or topic |
| Reminder | Notification instruction, schedule, timezone, status, optional date reference |
| Delivery attempt | Scheduled occurrence, attempt time, outcome, retry state |
| User settings | Timezone, channel destination, notification preferences |

A reminder can refer to an important date without duplicating that date as another authoritative value. Updating the date must update future linked notifications consistently.

Use UTC instants for due deliveries and retain the timezone and local scheduling rule for recurring reminders. Define daylight-saving behavior before implementation. Use durable delivery records and transactional job claims to recover after a crash.

## Privacy and authority

- Restrict access to the configured owner, including identity checks for any chat channel.
- Keep credentials outside memory documents and source control.
- Disclose what information goes to an external LLM or notification provider.
- Limit memory operations to the configured folder and prevent path traversal or symlink escapes.
- Treat imported content and recalled memories as untrusted input.
- Deleting a memory removes it from active retrieval and derived indexes. Explain separately how backups and retained conversations expire.
- Do not give the agent shell access or permission to change its own runtime in the first version.

## Out of scope

- Additional MCP servers and integrations.
- Calendar, email, browser, and general-purpose task automation.
- Multi-user accounts, shared memories, and team permissions.
- Autonomous goal pursuit, unsolicited check-ins, and self-modification.
- A requirement to host the LLM locally.
- A custom database service, distributed scheduling, or a vector database unless a demonstrated need changes the plan.

## Rough delivery plan

1. **Prove the full reminder path.** Select a channel. Accept one natural-language reminder, save it in SQLite, restart the service, and deliver the notification. Include owner authentication and timezone configuration.
2. **Add durable memory.** Save and recall Markdown memories across sessions. Support corrections, deletion, direct file edits, and citations to source documents.
3. **Add dates and recurring reminders.** Connect important dates to optional notifications. Add recurrence, snooze, cancellation, and the agreed downtime behavior.
4. **Make unattended operation dependable.** Test delivery failures, crash recovery, spending limits, backups, and restore. Document installation and routine maintenance.

Each stage keeps working code. Do not build all skill definitions before proving that a saved reminder reaches the user.

## First-version acceptance checks

- A fact saved in one session can be recalled after a service restart, with its source document identified.
- A user correction changes future recall. A deleted memory no longer appears in active retrieval.
- An ambiguous reminder request asks for clarification instead of inventing a time.
- A saved reminder survives restart and reaches the configured channel within 60 seconds of its due time under normal operation. This is a proposed target, subject to channel limits.
- A canceled reminder does not dispatch if cancellation completes before the worker claims it. Changes after dispatch begins report that delivery may already be underway.
- A recurring reminder follows the agreed timezone and daylight-saving rules.
- An unavailable model does not stop delivery of already saved reminders.
- A delivery failure produces a recorded outcome and bounded retries, not an endless loop.
- A restored backup contains readable memories, important dates, and pending reminders.
- An unauthorized sender cannot read memories or create reminders.

Test scheduling with a controllable clock, plus an end-to-end test through the selected notification channel.

## Decisions still needed

- Which conversation channel and notification channel come first? They need not be the same.
- Which LLM provider and runtime fit the operating budget and privacy requirements?
- What conversation history is retained, and for how long?
- Should inferred memories ever save automatically, or always require approval?
- What are the default notification time, quiet hours, and reminder lead times for important dates?
- What are the rules for missed reminders, leap-day dates, and daylight-saving transitions?
- What backup destination, retention period, and recovery expectations fit the host?

Resolve only the decisions needed for the first end-to-end slice before choosing a detailed stack or schema.
