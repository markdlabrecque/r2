import { z } from 'zod';
import {
  R2Error,
  toDeliveryAttemptDto,
  toProposalDto,
  toReminderDto,
  type DeliveryAttemptDto,
  type ProposalDto,
  type ReminderDto,
} from './contracts.ts';
import { resolveLocalTime } from './reminders.ts';
import type { FeaturePlugin } from './routes.ts';

export const MAX_MESSAGE_CHARS = 1000;
export const MAX_REMINDER_TEXT_CHARS = 500;
export const PROPOSAL_TTL_MS = 15 * 60_000;
/** Model calls allowed per UTC day. A persistent bound on spending, not a rate limit. */
export const DAILY_MODEL_LIMIT = 200;

const chatBody = z.strictObject({ message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) });
const confirmBody = z.strictObject({
  proposalId: z.string().min(1).max(100),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
});

export type ChatReply =
  | { type: 'clarify'; message: string }
  | { type: 'unsupported'; message: string }
  | { type: 'proposal'; message: string; proposal: ProposalDto; utcOffset: string };

export interface ReminderListItem extends ReminderDto {
  deliveryAttempts: DeliveryAttemptDto[];
}

const dayBucket = (now: number): string => `chat:${new Date(now).toISOString().slice(0, 10)}`;

/**
 * Chat and confirmation. The model only proposes; this plugin validates the time and a
 * reminder exists only after the owner's explicit confirmation commits to SQLite. Listing
 * and confirming never touch the model, so saved reminders work without OpenAI.
 */
export const chatPlugin: FeaturePlugin = {
  name: 'chat',
  register(app, { storage, clock, modelInterpreter, config }) {
    app.post('/api/chat', async (request, reply): Promise<ChatReply> => {
      const body = chatBody.safeParse(request.body);
      if (!body.success) {
        throw new R2Error('invalid_request', `Send a message of 1 to ${MAX_MESSAGE_CHARS} characters.`);
      }
      const { timezone } = storage.getSettings();
      if (timezone === null) throw new R2Error('invalid_request', 'Choose your timezone before creating reminders.');
      if (modelInterpreter === undefined) {
        throw new R2Error(
          'unavailable',
          config.chat.enabled
            ? 'The assistant is not available right now. Nothing was saved.'
            : 'The assistant is not configured on the server. Saved reminders still send.',
        );
      }
      const now = clock.now();
      if (!storage.consumeModelQuota(dayBucket(now), DAILY_MODEL_LIMIT).allowed) {
        throw new R2Error('quota_exceeded', 'The daily assistant limit has been reached. Try again tomorrow.');
      }

      let outcome;
      try {
        outcome = await modelInterpreter.interpret(body.data.message, now, timezone);
      } catch (error) {
        // The message is private: log only the failure class.
        request.log.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'model interpretation failed');
        throw new R2Error('unavailable', 'The assistant could not answer. Nothing was saved. Try again.');
      }

      reply.header('Cache-Control', 'no-store');
      if (outcome.type === 'clarify') return { type: 'clarify', message: outcome.question.slice(0, 300) };
      if (outcome.type === 'unsupported') {
        return { type: 'unsupported', message: 'R2 can only set a single one-off reminder for now.' };
      }

      const text = outcome.text.trim();
      if (text === '' || text.length > MAX_REMINDER_TEXT_CHARS) {
        return { type: 'clarify', message: 'What should I remind you about?' };
      }
      const resolved = resolveLocalTime(outcome.localDateTime, timezone, now);
      if (!resolved.ok) return { type: 'clarify', message: resolved.message };

      const proposal = storage.storeProposal({
        text,
        dueAt: resolved.dueAt,
        timezone,
        localDateTime: resolved.localDateTime,
        // A proposal never outlives its due time, so confirming cannot create a past reminder.
        expiresAt: Math.min(now + PROPOSAL_TTL_MS, resolved.dueAt),
      });
      return {
        type: 'proposal',
        message: 'Save this reminder?',
        proposal: toProposalDto(proposal),
        utcOffset: resolved.utcOffset,
      };
    });

    app.post('/api/reminders/confirm', async (request) => {
      const body = confirmBody.safeParse(request.body);
      if (!body.success) throw new R2Error('invalid_request', 'Confirm with a proposal id and a request id.');
      storage.expireProposals();
      const reminder = storage.confirmProposal(body.data.proposalId, body.data.requestId);
      return { reminder: toReminderDto(reminder) };
    });

    app.get('/api/reminders', async (): Promise<{ reminders: ReminderListItem[] }> => ({
      reminders: storage.listReminders().map((r) => ({
        ...toReminderDto(r),
        deliveryAttempts: storage.listDeliveryAttempts(r.id).map(toDeliveryAttemptDto),
      })),
    }));
  },
};
