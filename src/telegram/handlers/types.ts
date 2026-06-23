import type { CommandResponse, ChatContext, IncomingMessage, Person } from '../../domain/types.js';
import type { Permission } from '../../services/index.js';
import type { Services } from '../../services/index.js';

/** Everything a handler needs to do its job. Handlers parse input, call services, return a response. */
export interface HandlerInput {
  services: Services;
  person: Person;
  context: ChatContext;
  message: IncomingMessage;
  args: string[];
  botUsername: string;
  /** true when the bot was directly addressed (mention/reply) or the interaction is explicit (command/callback) */
  addressed: boolean;
}

export interface CommandSpec {
  command: string;
  /** extra command names that route to the same handler (not shown in the menu) */
  aliases?: readonly string[];
  permissions: readonly Permission[];
  needsTermsAccepted: boolean;
  /** menu ordering: lower first */
  priority: number;
  /** documented as admin-only in help (does not change permission logic) */
  adminOnly?: boolean;
  /** This command starts a billable/limited conversational turn. */
  quotaConversation?: boolean;
  handle(input: HandlerInput): Promise<CommandResponse | null>;
}

export interface CallbackSpec {
  /** callback_data action prefix this handler responds to */
  action: string;
  permissions: readonly Permission[];
  needsTermsAccepted: boolean;
  handle(input: HandlerInput): Promise<CommandResponse | null>;
}

export const Priority = {
  FIRST: 0,
  DEFAULT: 1,
  ADMIN: 2,
  LAST: 3,
} as const;
