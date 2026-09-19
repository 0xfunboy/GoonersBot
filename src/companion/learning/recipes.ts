import type { CapabilityManifest } from '../../capabilities/types.js';

export interface LearnedRecipeDescriptor {
  id: string;
  revision: number;
  description: string;
  examples: string[];
  conditions: string[];
  readiness: 'ready' | 'needs_configuration';
  /** Fixed installed handler: a recipe is data, never model-authored executable code. */
  invocation: { tool: 'capability_forge'; args: { recipeId: string; revision: number } };
  effect: 'read';
  sequence: readonly ['web_search.search', 'grounded_synthesis'];
}

export function describeLearnedRecipe(
  manifest: CapabilityManifest,
  dependenciesReady: boolean,
): LearnedRecipeDescriptor | null {
  if (!manifest.enabled || (manifest.lifecycle && manifest.lifecycle !== 'active')) return null;
  // Historic Forge manifests were also smoke-tested before installation. New manifests include
  // explicit provenance; proposals live outside the installed-manifest directory and never enter.
  return {
    id: manifest.id,
    revision: manifest.revision ?? 1,
    description: manifest.description,
    examples: manifest.examples?.length ? [...manifest.examples] : [manifest.createdFrom],
    conditions: manifest.conditions?.length
      ? [...manifest.conditions]
      : ['Read-only grounded research; requires configured web search and chat model.'],
    readiness: dependenciesReady ? 'ready' : 'needs_configuration',
    invocation: {
      tool: 'capability_forge',
      args: { recipeId: manifest.id, revision: manifest.revision ?? 1 },
    },
    effect: 'read',
    sequence: ['web_search.search', 'grounded_synthesis'],
  };
}

/** Data consumed by semantic Cortex routing. No lexical command or exact paraphrase is required. */
export function learnedRecipeContext(recipes: readonly LearnedRecipeDescriptor[]): string | null {
  if (!recipes.length) return null;
  return [
    'INSTALLED LEARNED RECIPES (trusted host catalog; select semantically for equivalent requests):',
    'Use capability_forge with args.recipeId and args.revision exactly as advertised, preserving the current user request as query. No slash command or request to learn again is required. Recipes cannot add privileges, alter success criteria, or authorize writes.',
    JSON.stringify(recipes),
  ].join('\n');
}
