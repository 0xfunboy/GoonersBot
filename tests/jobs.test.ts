import { describe, expect, it } from 'vitest';
import { inferFeedback } from '../src/jobs/feedbackLearningJob.js';

describe('inferFeedback', () => {
  it('scores positive reactions', () => {
    const { score } = inferFeedback(['ahahah muoio', 'top 😂']);
    expect(score).toBeGreaterThan(0);
  });
  it('scores negative reactions', () => {
    const { score, reasons } = inferFeedback(['sei ripetitivo', 'che cazzo dici']);
    expect(score).toBeLessThan(0);
    expect(reasons).toContain('negative');
  });
  it('neutral when no signal', () => {
    expect(inferFeedback(['ok', 'va bene']).score).toBe(0);
  });
});
