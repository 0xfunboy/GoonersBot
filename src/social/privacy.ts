import { containsSensitive } from '../utils/secrets.js';
import type { SocialEvidenceSource, SocialObservation } from './types.js';

/**
 * The LLM prompt asks the miner to avoid private/sensitive profiling, but prompts are not a
 * security boundary. These patterns are deliberately conservative and run again in the
 * deterministic evolution layer before anything can be persisted.
 */
const PRIVATE_PROFILE_PATTERNS: RegExp[] = [
  // Direct contact data and precise whereabouts.
  /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i,
  /\b(?:gps|coordinate|coordinates|lat(?:itude)?|lon(?:gitude)?|cap|postcode|zip code)\b/i,
  /\b-?\d{1,2}\.\d{4,}\s*[,;/]\s*-?\d{1,3}\.\d{4,}\b/,

  // Health, diagnoses and disability.
  /\b(?:health|medical|diagnos\w*|disease|disabil\w*|mental health|salute|malatt\w*|diagnos\w*|disabilit[aà]|autis\w*|adhd|hiv|aids|cancer|tumor\w*|diabet\w*|bipolar\w*|depress\w*)\b/i,

  // Political/religious identity, sexuality and ethnicity.
  /\b(?:politic\w*|partito|party affiliation|vot(?:a|a per|er)|religio\w*|religion|fede|cattolic\w*|musulman\w*|islam\w*|ebre\w*|jewish|cristian\w*|atheis\w*|ate[oa]\b|sexualit\w*|orientamento sessuale|gay\b|lesbi\w*|bisess\w*|transgender|etni\w*|ethnic\w*|razza|race\b)\b/i,

  // Financial circumstances and legal allegations.
  /\b(?:salary|income|net worth|stipendio|reddito|patrimonio|debito|debt|conto corrente|bank account)\b/i,
  /\b(?:criminale|criminal\b|pedofil\w*|stuprator\w*|rapist\b|assassin\w*|murderer\b|ladro\b|thief\b|arrestat\w*|condannat\w*|convicted\b|denunciat\w*)\b/i,
];

const MIN_CONFIDENCE: Record<SocialEvidenceSource, number> = {
  self_declared: 0.35,
  admin: 0.5,
  direct_observation: 0.45,
  repeated_behavior: 0.55,
  peer_report: 0.45,
  inferred: 0.65,
  migration: 0.4,
};

function observationText(observation: SocialObservation): string {
  if (observation.kind === 'facet') {
    return `${observation.facet} ${observation.key} ${observation.value ?? ''}`;
  }
  if (observation.kind === 'identity') {
    return `${observation.displayName ?? ''} ${observation.alias ?? ''}`;
  }
  if (observation.kind === 'running_joke') {
    return `${observation.canonicalKey} ${observation.label} ${observation.variant ?? ''}`;
  }
  if (observation.kind === 'chat_norm') {
    return `${observation.key} ${observation.value ?? ''}`;
  }
  return '';
}

export function hasMinimumSocialConfidence(observation: SocialObservation): boolean {
  return (
    Number.isFinite(observation.confidence) &&
    observation.confidence >= MIN_CONFIDENCE[observation.source] &&
    observation.confidence <= 1
  );
}

export function isPrivacySafeSocialObservation(observation: SocialObservation): boolean {
  const text = observationText(observation).trim();
  if (!text) return true;
  return (
    !containsSensitive(text) && !PRIVATE_PROFILE_PATTERNS.some((pattern) => pattern.test(text))
  );
}

/** Hard persistence gate shared by automatic mining and direct/manual evolution calls. */
export function isValidSocialObservation(observation: SocialObservation): boolean {
  return hasMinimumSocialConfidence(observation) && isPrivacySafeSocialObservation(observation);
}
