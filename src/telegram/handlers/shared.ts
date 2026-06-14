import type { KeyboardResponse } from '../../domain/types.js';
import type { Services } from '../../services/index.js';

export const TERMS_CALLBACK = 'terms_response';
export const SET_MODE_CALLBACK = 'set_chat_mode';
export const DELETE_MODE_CALLBACK = 'delete_chat_mode';
export const SHOW_MODES_CALLBACK = 'show_chat_modes';
export const SET_LANGUAGE_CALLBACK = 'set_chat_language';
export const SHOW_LANGUAGES_CALLBACK = 'show_chat_languages';

export function termsKeyboard(services: Services, language: string): KeyboardResponse {
  return {
    options: [
      {
        id: 'accept',
        label: services.localizer.t('terms_accept_button', {}, language) ?? 'Accept',
      },
      {
        id: 'decline',
        label: services.localizer.t('terms_decline_button', {}, language) ?? 'Decline',
      },
    ],
    callback: TERMS_CALLBACK,
    buttonAction: TERMS_CALLBACK,
  };
}

export async function modesKeyboard(
  services: Services,
  chatId: number,
  buttonAction: string,
): Promise<KeyboardResponse> {
  const modes = await services.modes.list(chatId);
  return {
    options: modes.map((m) => ({ id: m.id, label: m.name })),
    callback: SHOW_MODES_CALLBACK,
    buttonAction,
  };
}

export function languagesKeyboard(services: Services, buttonAction: string): KeyboardResponse {
  const langs = services.localizer.supportedLanguages();
  return {
    options: langs.map((l) => ({ id: l, label: l })),
    callback: SHOW_LANGUAGES_CALLBACK,
    buttonAction,
  };
}
