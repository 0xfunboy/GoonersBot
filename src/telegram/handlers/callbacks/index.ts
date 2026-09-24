import type { CallbackSpec } from '../types.js';
import type {
  AnimeArchiveConfirmationResult,
  AnimeArchiveServiceRejectReason,
} from '../../../anime/archive/service.js';
import {
  DELETE_MODE_CALLBACK,
  SET_LANGUAGE_CALLBACK,
  SET_MODE_CALLBACK,
  SHOW_LANGUAGES_CALLBACK,
  SHOW_MODES_CALLBACK,
  TERMS_CALLBACK,
} from '../shared.js';
import {
  getCachedImagePrompt,
  cacheGeneratedImagePrompt,
  buildImagePlaygroundRows,
  nextArtisticMedium,
} from '../../../services/imagePromptCache.js';
import { getCachedCodeSnippet } from '../../../services/codeSnippetCache.js';
import type { ImageProfile } from '../../../providers/image/stableDiffusion.js';
import type { ImageMedium } from '../../../services/imagePrompt.js';
import { formatPersonMention } from '../../../utils/handles.js';
import { ImageProgressReporter } from '../../imageProgress.js';

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
    if (!language || !services.localizer.supportedLanguages().includes(language)) return null;
    await services.storage.chats.setLanguage(context.chatId, language);
    return { text: 'language_set', vars: { language } };
  },
};

/** show_chat_modes|<buttonAction>|<page> - pagination repaint. */
const showChatModes: CallbackSpec = {
  action: SHOW_MODES_CALLBACK,
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  async handle({ services, context, args }) {
    const buttonAction = args[0] ?? SET_MODE_CALLBACK;
    const modes = await services.modes.list(context.chatId);
    const page = boundedPage(args[1], modes.length);
    return {
      text: 'choose_mode',
      keyboard: {
        options: modes.map((m) => ({ id: m.id, label: m.name })),
        callback: SHOW_MODES_CALLBACK,
        buttonAction,
        page,
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
    const page = boundedPage(args[1], langs.length);
    return {
      text: 'choose_language',
      keyboard: {
        options: langs.map((l) => ({ id: l, label: l })),
        callback: SHOW_LANGUAGES_CALLBACK,
        buttonAction,
        page,
      },
    };
  },
};

/** terms_response|accept|decline - record terms acceptance/decline. */
const termsResponse: CallbackSpec = {
  action: TERMS_CALLBACK,
  permissions: ['not_banned'],
  needsTermsAccepted: false,
  approvalExempt: true,
  ownerOnly: true,
  async handle({ services, person, context, args }) {
    const action = args[0];
    const vars = { user_handle: person.userHandle };
    if (action === 'accept') {
      await services.terms.accept(person.userHandle);
      // In a non-approved private chat, follow the signature with the "request approval" notice.
      if (!context.isGroup && !services.isApproved(person, context)) {
        return {
          text: 'dm_info',
          vars: { admin_handle: services.adminContact() },
          deleteOrigin: true,
        };
      }
      // delete the (personal) terms prompt and confirm citing who accepted
      return { text: 'terms_accepted', vars, deleteOrigin: true };
    }
    if (action === 'decline') {
      await services.terms.decline(person.userHandle);
      return { text: 'terms_declined', vars, deleteOrigin: true };
    }
    return { text: 'invalid_terms_action' };
  },
};

/** anime_archive|yes|<nonce> / anime_archive|no|<nonce>. All payload lives server-side. */
const animeArchiveConfirmation: CallbackSpec = {
  action: 'anime_archive',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  ownerOnly: true,
  async handle({ services, person, context, args }) {
    const result = await services.animeArchive.confirmCallback(args, {
      actorTelegramId: person.telegramId,
      chatId: context.chatId,
      confirmationMessageId: context.messageId ?? 0,
      isAdmin: services.isAnimeArchiveAdmin(person, context),
      quotaBypass: services.bypassesGroupPlan(person, context),
      signal: AbortSignal.timeout(20_000),
    });
    return archiveConfirmationResponse(result);
  },
};

/** task_cancel|<taskId> - cancel an active companion task */
const taskCancel: CallbackSpec = {
  action: 'task_cancel',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  approvalExempt: true,
  async handle({ services, person, context, args }) {
    const taskId = args[0];
    if (!taskId) return null;
    const task = await services.companionWork.tasks.getById(taskId);
    if (!task) {
      return {
        rawText: 'Task non trovato o già terminato.',
        textFormat: 'plain',
        ephemeralMs: 5000,
      };
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return {
        rawText: 'Questo task è già stato completato o annullato.',
        textFormat: 'plain',
        deleteOrigin: true,
      };
    }
    // Authority check: author of the task or bot/chat admin
    const isAuthor = task.contract.scope.actorTelegramId === person.telegramId;
    const isAdmin = context.isGroupAdmin || services.permissions.isBotAdminPerson(person);
    if (!isAuthor && !isAdmin) {
      return {
        rawText: 'Non hai i permessi per annullare il task avviato da un altro utente.',
        textFormat: 'plain',
        ephemeralMs: 6000,
      };
    }
    await services.companionWork.tasks.control({
      taskId: task.id,
      scope: task.contract.scope,
      expectedVersion: task.version,
      action: 'cancel',
    });
    return {
      rawText: `⏹️ Task annullato: ${task.contract.goal.slice(0, 50)}`,
      textFormat: 'plain',
      deleteOrigin: true,
    };
  },
};

/** task_info|<taskId> - inspect status and progress of an active task */
const taskInfo: CallbackSpec = {
  action: 'task_info',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  approvalExempt: true,
  async handle({ services, args }) {
    const taskId = args[0];
    if (!taskId) return null;
    const task = await services.companionWork.tasks.getById(taskId);
    if (!task) {
      return {
        rawText: 'Task non trovato.',
        textFormat: 'plain',
        ephemeralMs: 5000,
      };
    }
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - task.createdAt.getTime()) / 1000));
    const goal =
      task.contract.goal.length > 80 ? `${task.contract.goal.slice(0, 77)}...` : task.contract.goal;
    return {
      rawText: `ℹ️ **Dettagli Task**\n• **Obiettivo**: ${goal}\n• **Stato**: ${task.status}\n• **Tempo trascorso**: ${elapsedSeconds}s\n• **Tentativi**: ${task.attempts}`,
      textFormat: 'markdown',
      ephemeralMs: 12_000,
    };
  },
};

/** sample_style|<promptId> - cycle artistic medium/style for generated image */
const sampleStyle: CallbackSpec = {
  action: 'sample_style',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  async handle({ services, args, context, person, api }) {
    const promptId = args[0];
    if (!promptId) return null;
    const cached = getCachedImagePrompt(promptId);
    if (!cached) {
      return {
        rawText: 'Prompt non trovato o scaduto.',
        textFormat: 'plain',
        ephemeralMs: 5000,
      };
    }
    const userMention = formatPersonMention(person);
    const nextMedium = nextArtisticMedium(cached.medium);
    const profile = cached.profile as ImageProfile | undefined;
    const medium = nextMedium as ImageMedium;
    const chatNsfwMode = await services.storage.chats.getNsfwMode(
      context.chatId,
      services.config.env.LLM_NSFW_DEFAULT_MODE,
    );
    const nsfwEnabled = chatNsfwMode !== 'off';

    let progressReporter: ImageProgressReporter | null = null;
    if (api) {
      progressReporter = new ImageProgressReporter({
        api,
        chatId: context.chatId,
        replyToMessageId: context.messageId,
        initialPrompt: cached.prompt,
        prefix: `Sto preparando lo stile ${nextMedium} per ${userMention}`,
      });
      await progressReporter.start(cached.prompt);
    }

    try {
      const prepared = await services.imagePrompts.prepare(cached.prompt, {
        ...(profile ? { profile } : {}),
        context: {
          intent: `${cached.prompt} in ${nextMedium} style`,
          recentMessages: [],
          relevantLore: [],
        },
      });
      await progressReporter?.update(15, prepared.prompt, 'Avvio generazione...');
      const image = await services.media.generateImage(prepared.prompt, {
        profile: profile ?? prepared.profile,
        medium,
        rating: prepared.rating,
        negativePrompt: prepared.negativePrompt,
        aspectRatio: cached.aspectRatio ?? prepared.aspectRatio,
        preferredProvider: 'pony',
        nsfwEnabled,
        onProgress: async (percent, stage) => {
          await progressReporter?.update(percent, prepared.prompt, stage);
        },
      });
      await progressReporter?.delete();
      if (!image?.buffer) {
        return { text: 'image_unavailable' };
      }
      const newId = cacheGeneratedImagePrompt({
        prompt: cached.prompt,
        profile: cached.profile,
        medium: nextMedium,
        aspectRatio: cached.aspectRatio,
        rating: prepared.rating,
      });
      return {
        rawText: `Ecco la tua versione in stile ${nextMedium} ${userMention}`,
        textFormat: 'plain',
        imageBuffer: image.buffer,
        imageSpoiler: prepared.rating !== 'safe',
        customInlineKeyboard: buildImagePlaygroundRows(newId),
        usage: { imageCalls: image.generationAttempts ?? 1 },
      };
    } catch (err) {
      await progressReporter?.delete();
      throw err;
    }
  },
};

/** sample_ratio|<ratio>|<promptId> - switch aspect ratio */
const sampleRatio: CallbackSpec = {
  action: 'sample_ratio',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  async handle({ services, args, context, person, api }) {
    const [ratio, promptId] = args;
    if (!ratio || !promptId) return null;
    const validRatio = ['16:9', '9:16', '1:1'].includes(ratio)
      ? (ratio as '16:9' | '9:16' | '1:1')
      : '1:1';
    const cached = getCachedImagePrompt(promptId);
    if (!cached) {
      return {
        rawText: 'Prompt non trovato o scaduto.',
        textFormat: 'plain',
        ephemeralMs: 5000,
      };
    }
    const userMention = formatPersonMention(person);
    let ratioLabel = 'quadrata';
    if (validRatio === '9:16') ratioLabel = 'verticale';
    else if (validRatio === '16:9') ratioLabel = 'orizzontale';

    const chatNsfwMode = await services.storage.chats.getNsfwMode(
      context.chatId,
      services.config.env.LLM_NSFW_DEFAULT_MODE,
    );
    const nsfwEnabled = chatNsfwMode !== 'off';

    let progressReporter: ImageProgressReporter | null = null;
    if (api) {
      progressReporter = new ImageProgressReporter({
        api,
        chatId: context.chatId,
        replyToMessageId: context.messageId,
        initialPrompt: cached.prompt,
        prefix: `Sto preparando la versione ${ratioLabel} per ${userMention}`,
      });
      await progressReporter.start(cached.prompt);
    }

    try {
      const image = await services.media.generateImage(cached.prompt, {
        profile: cached.profile as ImageProfile | undefined,
        medium: cached.medium as ImageMedium | undefined,
        aspectRatio: validRatio,
        rating: cached.rating,
        negativePrompt: cached.negativePrompt,
        preferredProvider: 'pony',
        nsfwEnabled,
        onProgress: async (percent, stage) => {
          await progressReporter?.update(percent, cached.prompt, stage);
        },
      });
      await progressReporter?.delete();
      if (!image?.buffer) {
        return { text: 'image_unavailable' };
      }
      const newId = cacheGeneratedImagePrompt({
        ...cached,
        aspectRatio: validRatio,
      });
      return {
        rawText: `Ecco la tua versione ${ratioLabel} ${userMention}`,
        textFormat: 'plain',
        imageBuffer: image.buffer,
        imageSpoiler: cached.rating !== 'safe',
        customInlineKeyboard: buildImagePlaygroundRows(newId),
        usage: { imageCalls: image.generationAttempts ?? 1 },
      };
    } catch (err) {
      await progressReporter?.delete();
      throw err;
    }
  },
};

/** sample_remix|<promptId> - remix variation */
const sampleRemix: CallbackSpec = {
  action: 'sample_remix',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  async handle({ services, args, context, person, api }) {
    const promptId = args[0];
    if (!promptId) return null;
    const cached = getCachedImagePrompt(promptId);
    if (!cached) {
      return {
        rawText: 'Prompt non trovato o scaduto.',
        textFormat: 'plain',
        ephemeralMs: 5000,
      };
    }
    const userMention = formatPersonMention(person);
    const chatNsfwMode = await services.storage.chats.getNsfwMode(
      context.chatId,
      services.config.env.LLM_NSFW_DEFAULT_MODE,
    );
    const nsfwEnabled = chatNsfwMode !== 'off';
    const remixPrompt = `${cached.prompt}, creative remix variation, alternate details`;

    let progressReporter: ImageProgressReporter | null = null;
    if (api) {
      progressReporter = new ImageProgressReporter({
        api,
        chatId: context.chatId,
        replyToMessageId: context.messageId,
        initialPrompt: remixPrompt,
        prefix: `Sto preparando il remix per ${userMention}`,
      });
      await progressReporter.start(remixPrompt);
    }

    try {
      const image = await services.media.generateImage(remixPrompt, {
        profile: cached.profile as ImageProfile | undefined,
        medium: cached.medium as ImageMedium | undefined,
        aspectRatio: cached.aspectRatio,
        rating: cached.rating,
        negativePrompt: cached.negativePrompt,
        preferredProvider: 'pony',
        nsfwEnabled,
        onProgress: async (percent, stage) => {
          await progressReporter?.update(percent, remixPrompt, stage);
        },
      });
      await progressReporter?.delete();
      if (!image?.buffer) {
        return { text: 'image_unavailable' };
      }
      const newId = cacheGeneratedImagePrompt({
        ...cached,
        prompt: remixPrompt,
      });
      return {
        rawText: `Ecco il tuo remix ${userMention}`,
        textFormat: 'plain',
        imageBuffer: image.buffer,
        imageSpoiler: cached.rating !== 'safe',
        customInlineKeyboard: buildImagePlaygroundRows(newId),
        usage: { imageCalls: image.generationAttempts ?? 1 },
      };
    } catch (err) {
      await progressReporter?.delete();
      throw err;
    }
  },
};

/** code_patch|<snippetId> - generate quick peer review fix diff */
const codePatch: CallbackSpec = {
  action: 'code_patch',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  approvalExempt: true,
  async handle({ services, context, args }) {
    const snippetId = args[0];
    if (!snippetId) return null;
    const cached = getCachedCodeSnippet(snippetId);
    if (!cached) {
      return {
        rawText: 'Snippet di codice non trovato o sessione scaduta.',
        textFormat: 'plain',
        ephemeralMs: 5000,
      };
    }
    try {
      const model = await services.modelForChat(context.chatId);
      const res = await services.llm.chatCompletion({
        system:
          'You are a direct, highly technical peer software engineer reviewing code in a chat. ' +
          'Provide a clean, focused fix for the bug or improvement. ' +
          'Prefer outputting a git unified diff (`diff`) or a corrected code block with a one-sentence rationale. ' +
          'No robotic filler, no verbose lectures.',
        messages: [
          {
            role: 'user',
            content: `Code:\n\`\`\`\n${cached.code}\n\`\`\`${cached.context ? `\nContext: ${cached.context}` : ''}`,
          },
        ],
        ...(model ? { model } : {}),
        temperature: 0.2,
      });
      const fix = res.text.trim();
      if (!fix) {
        return {
          rawText: 'Impossibile generare una patch automatica per questo snippet.',
          textFormat: 'plain',
        };
      }
      return {
        rawText: `💡 **Patch / Fix Consigliato**:\n\n${fix}`,
        textFormat: 'markdown',
      };
    } catch {
      return {
        rawText: 'Errore durante la generazione della patch.',
        textFormat: 'plain',
        ephemeralMs: 5000,
      };
    }
  },
};

export const callbackHandlers: CallbackSpec[] = [
  setChatMode,
  deleteChatMode,
  setChatLanguage,
  showChatModes,
  showChatLanguages,
  animeArchiveConfirmation,
  termsResponse,
  taskCancel,
  taskInfo,
  sampleStyle,
  sampleRatio,
  sampleRemix,
  codePatch,
];

function archiveConfirmationResponse(result: AnimeArchiveConfirmationResult) {
  if (result.status === 'queued') {
    const count = result.job.episodes.length;
    return {
      rawText:
        result.created || result.changed
          ? count === 1
            ? 'Perfetto, episodio in coda. Te lo mando qui appena è pronto.'
            : `Perfetto, archivio in coda: ${count} episodi, uno alla volta.`
          : 'Questa richiesta è già stata presa in carico.',
      textFormat: 'plain' as const,
      clearOriginKeyboard: true,
    };
  }
  if (result.status === 'cancelled') {
    return {
      rawText: 'Va bene, richiesta annullata.',
      textFormat: 'plain' as const,
      clearOriginKeyboard: true,
    };
  }
  return {
    rawText: archiveRejectionText(result.reason),
    textFormat: 'plain' as const,
  };
}

function archiveRejectionText(reason: AnimeArchiveServiceRejectReason): string {
  switch (reason) {
    case 'admin_required':
      return 'Per confermare una serie completa devi essere ancora amministratore.';
    case 'quota_denied':
      return 'La quota media della chat è esaurita; riprova più tardi.';
    case 'expired':
      return 'Questa conferma è scaduta.';
    case 'already_consumed':
      return 'Questa conferma è già stata usata.';
    case 'source_unavailable':
      return 'La sorgente non risponde correttamente: la conferma resta disponibile per riprovare.';
    case 'wrong_actor':
      return 'Questa conferma appartiene all’utente che ha richiesto il download.';
    case 'wrong_chat':
      return 'Questa conferma non appartiene a questa chat.';
    case 'invalid_confirmation':
      return 'Questa conferma non corrisponde più al messaggio con i pulsanti.';
    case 'not_found':
      return 'Questa conferma non esiste più.';
    case 'bulk_disabled':
    case 'disabled':
      return 'L’archivio anime non è disponibile in questo momento.';
    default:
      return 'Conferma archivio non valida.';
  }
}

function boundedPage(raw: string | undefined, itemCount: number): number {
  const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  const lastPage = Math.max(0, Math.ceil(itemCount / 8) - 1);
  return Math.max(0, Math.min(lastPage, Number.isSafeInteger(parsed) ? parsed : 0));
}
