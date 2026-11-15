# R2 reminders

R2 lets one owner explicitly confirm one-off reminders and receive generic notifications in one connected browser. A saved reminder, a push provider's acceptance and the owner's observation of a notification are different things.

## Language

### Requests and commitments

**Owner**:
The single person whose reminders and notification preferences R2 manages, regardless of which authorized device they use.
_Avoid_: Customer, tenant, multiple users

**Reminder request**:
The owner's natural-language request for a reminder, not yet a commitment to schedule it.
_Avoid_: Reminder, saved message

**Clarification**:
A question identifying information needed before a reminder can be proposed. It is not a saved reminder or a promise to remember earlier conversation.
_Avoid_: Scheduled request, conversation memory

**Proposal**:
A time-limited candidate reminder presented for the owner's explicit confirmation. It contains the proposed reminder text and its resolved date, time and timezone but is not yet scheduled.
_Avoid_: Pending reminder, draft reminder

**Confirmation**:
The owner's explicit acceptance of a particular proposal as a saved reminder. Repeating that confirmation does not create another reminder.
_Avoid_: Model approval, implicit consent

**Reminder**:
A saved one-off commitment to attempt notification for the owner's chosen due time. It retains its original text and time independently of later interpretation or delivery outcomes.
_Avoid_: Notification, chat message, task

### Time

**Owner timezone**:
The explicitly chosen named timezone used to interpret new requests. A reminder's saved timezone remains its own even if the owner later changes this setting.
_Avoid_: Server timezone, inferred timezone

**Due time**:
The original instant for which the reminder was confirmed, together with its local date, time and timezone. It does not move when notification is delayed or retried.
_Avoid_: Retry time, send time

**Overdue reminder**:
A reminder whose original due time has passed and whose notification work is not complete. Being overdue does not by itself mean notification has failed.
_Avoid_: Expired reminder, missed reminder

**Next attempt time**:
The earliest time at which the reminder's next delivery attempt is eligible to begin. It can change without changing the due time.
_Avoid_: Rescheduled due time

### Notification and evidence

**Connected browser**:
The one browser currently registered to receive R2 notifications for the owner. Other authorized devices may use R2 without becoming notification recipients.
_Avoid_: Owner device, all signed-in devices

**Subscription readiness**:
The recorded result that a test notification was accepted for the currently connected browser. It is not evidence that a notification appeared or that the owner saw it.
_Avoid_: Confirmed receipt, delivery guarantee

**Test notification**:
A generic notification used to check the connected browser's notification path, rather than to announce a saved reminder becoming due.
_Avoid_: Scheduled reminder, end-to-end acceptance

**Notification**:
A generic browser alert that invites the owner to open R2 without disclosing reminder text or due time.
_Avoid_: Reminder, reminder contents

**Delivery attempt**:
One recorded effort to submit a reminder notification to the push provider. Its outcome is distinct from the reminder's overall progress and from observed display.
_Avoid_: Delivered reminder, receipt

**Provider acceptance**:
The push provider's acknowledgement of a submitted notification. It does not establish browser display or owner observation.
_Avoid_: Delivered, seen, read, acknowledged by the owner

**Unknown attempt outcome**:
An attempt for which R2 cannot establish whether the provider accepted the notification. Another attempt may therefore produce a duplicate notification.
_Avoid_: Definite failure, definite non-delivery

**Observed notification**:
A notification whose actual display the owner has verified. This is evidence about that display, not a guarantee for future reminders.
_Avoid_: Provider acceptance, inferred delivery

**Failed reminder**:
A reminder for which automatic notification attempts have stopped because of a permanent failure or an exhausted attempt budget. Its saved details still exist.
_Avoid_: Deleted reminder, silently retried reminder

**Notification pause**:
A temporary stop on starting new reminder delivery attempts that preserves saved schedules. It does not cancel reminders or retract an attempt already in progress.
_Avoid_: Cancellation, snooze, deletion
