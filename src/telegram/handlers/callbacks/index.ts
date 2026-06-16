import type { CallbackSpec } from '../types.js';
import {
  DELETE_MODE_CALLBACK,
  SET_LANGUAGE_CALLBACK,
  SET_MODE_CALLBACK,
  SHOW_LANGUAGES_CALLBACK,
  SHOW_MODES_CALLBACK,
  TERMS_CALLBACK,
} from '../shared.js';

/** set_chat_mode|<modeId> - activate a mode. */
const setChatMode: CallbackSpec = {
  action: SET_MODE_CALLBACK,
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  async handle({ services, context, args }) {
    const modeId = args[0];
    if (!modeId) return null;
    const name = await services.modes.getNameById(context.chatId, modeId);
    const ok = await services.modes.setActive(context.chatId, modeId);
    if (!ok || !name) return null;
    return { text: 'mode_set', vars: { mode_name: name } };
  },
};

/** delete_chat_mode|<modeId> - delete a mode. */
const deleteChatMode: CallbackSpec = {
  action: DELETE_MODE_CALLBACK,
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  async handle({ services, context, args }) {
    const modeId = args[0];
    if (!modeId) return null;
    const name = await services.modes.getNameById(context.chatId, modeId);
    const ok = await services.modes.delete(context.chatId, modeId);
    if (!ok) return null;
    return { text: 'mode_deleted', vars: { mode_name: name ?? 'mode' } };
  },
};

/** set_chat_language|<lang> - set the chat language. */
const setChatLanguage: CallbackSpec = {
  action: SET_LANGUAGE_CALLBACK,
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  async handle({ services, context, args }) {
    const language = args[0];
    if (!language) return null;
    await services.storage.chats.setLanguage(context.chatId, language);
    return { text: 'language_set', vars: { language } };
  },
};

/**
 * show_chat_modes|<buttonAction>|<page> - pagination repaint. Returns a fresh modes keyboard.
 * (The keyboard renderer always shows page 0; richer pagination is a documented simplification.)
 */
const showChatModes: CallbackSpec = {
  action: SHOW_MODES_CALLBACK,
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  async handle({ services, context, args }) {
    const buttonAction = args[0] ?? SET_MODE_CALLBACK;
    const modes = await services.modes.list(context.chatId);
    return {
      text: 'choose_mode',
      keyboard: {
        options: modes.map((m) => ({ id: m.id, label: m.name })),
        callback: SHOW_MODES_CALLBACK,
        buttonAction,
      },
    };
  },
};

/** show_chat_languages|<buttonAction>|<page> - pagination repaint for languages. */
const showChatLanguages: CallbackSpec = {
  action: SHOW_LANGUAGES_CALLBACK,
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  async handle({ services, args }) {
    const buttonAction = args[0] ?? SET_LANGUAGE_CALLBACK;
    const langs = services.localizer.supportedLanguages();
    return {
      text: 'choose_language',
      keyboard: {
        options: langs.map((l) => ({ id: l, label: l })),
        callback: SHOW_LANGUAGES_CALLBACK,
        buttonAction,
      },
    };
  },
};

/** terms_response|accept|decline - record terms acceptance/decline. */
const termsResponse: CallbackSpec = {
  action: TERMS_CALLBACK,
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  async handle({ services, person, args }) {
    const action = args[0];
    if (action === 'accept') {
      await services.terms.accept(person.userHandle);
      return { text: 'terms_accepted' };
    }
    if (action === 'decline') {
      await services.terms.decline(person.userHandle);
      return { text: 'terms_declined' };
    }
    return { text: 'invalid_terms_action' };
  },
};

export const callbackHandlers: CallbackSpec[] = [
  setChatMode,
  deleteChatMode,
  setChatLanguage,
  showChatModes,
  showChatLanguages,
  termsResponse,
];
