export const QUOTA_PLAN_IDS = ['free', 'plus', 'pro'] as const;

export type QuotaPlanId = (typeof QUOTA_PLAN_IDS)[number];

export interface QuotaPlan {
  id: QuotaPlanId;
  conversationDaily: number;
  conversationHourly: number;
  llmTokensDaily: number;
  webSearchDaily: number;
  pageScanDaily: number;
  newsDaily: number;
  imagesDaily: number;
  mediaDaily: number;
  mediaBytesDaily: number;
  passiveHourly: number;
  antiFlood: {
    userCooldownSeconds: number;
    chatCooldownSeconds: number;
    userBurstPerMinute: number;
    chatBurstPerMinute: number;
  };
}

const MB = 1024 * 1024;

export const QUOTA_PLANS: Record<QuotaPlanId, QuotaPlan> = {
  free: {
    id: 'free',
    conversationDaily: 12,
    conversationHourly: 3,
    llmTokensDaily: 30_000,
    webSearchDaily: 8,
    pageScanDaily: 15,
    newsDaily: 2,
    imagesDaily: 1,
    mediaDaily: 3,
    mediaBytesDaily: 100 * MB,
    passiveHourly: 0,
    antiFlood: {
      userCooldownSeconds: 30,
      chatCooldownSeconds: 20,
      userBurstPerMinute: 1,
      chatBurstPerMinute: 3,
    },
  },
  plus: {
    id: 'plus',
    conversationDaily: 32,
    conversationHourly: 9,
    llmTokensDaily: 150_000,
    webSearchDaily: 33,
    pageScanDaily: 75,
    newsDaily: 9,
    imagesDaily: 18,
    mediaDaily: 20,
    mediaBytesDaily: 600 * MB,
    passiveHourly: 9,
    antiFlood: {
      userCooldownSeconds: 6,
      chatCooldownSeconds: 3,
      userBurstPerMinute: 6,
      chatBurstPerMinute: 16,
    },
  },
  pro: {
    id: 'pro',
    conversationDaily: 72,
    conversationHourly: 18,
    llmTokensDaily: 250_000,
    webSearchDaily: 75,
    pageScanDaily: 200,
    newsDaily: 24,
    imagesDaily: 48,
    mediaDaily: 40,
    mediaBytesDaily: 1200 * MB,
    passiveHourly: 12,
    antiFlood: {
      userCooldownSeconds: 1,
      chatCooldownSeconds: 1,
      userBurstPerMinute: 20,
      chatBurstPerMinute: 60,
    },
  },
};

export const DEFAULT_QUOTA_PLAN: QuotaPlanId = 'free';

export function isQuotaPlanId(value: string): value is QuotaPlanId {
  return (QUOTA_PLAN_IDS as readonly string[]).includes(value);
}
