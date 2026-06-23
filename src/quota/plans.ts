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
    conversationDaily: 24,
    conversationHourly: 6,
    llmTokensDaily: 100_000,
    webSearchDaily: 25,
    pageScanDaily: 50,
    newsDaily: 6,
    imagesDaily: 5,
    mediaDaily: 10,
    mediaBytesDaily: 300 * MB,
    passiveHourly: 6,
    antiFlood: {
      userCooldownSeconds: 12,
      chatCooldownSeconds: 8,
      userBurstPerMinute: 3,
      chatBurstPerMinute: 8,
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
