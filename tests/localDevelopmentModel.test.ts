import { describe, expect, it, vi } from 'vitest';
import type { JsonRequest, LLMProvider } from '../src/providers/llm/types.js';
import {
  LOCAL_DEVELOPMENT_LIMITS,
  LocalDevelopmentModel,
  LocalDevelopmentModelError,
  isSafeLocalDevelopmentPath,
  isSafeNewLocalDevelopmentPath,
  localDevelopmentDraftSchema,
  localDevelopmentSelectionSchema,
  type LocalDevelopmentCandidateFile,
} from '../src/capabilities/localDevelopmentModel.js';

type StructuredResponder = (request: JsonRequest<unknown>) => Promise<unknown>;

function providerWith(
  responder: StructuredResponder,
  chat = true,
): {
  llm: LLMProvider;
  structured: ReturnType<typeof vi.fn<StructuredResponder>>;
} {
  const structured = vi.fn<StructuredResponder>(responder);
  const llm = {
    name: 'gemrouter-test',
    capabilities: {
      chat,
      vision: false,
      transcription: false,
      imageGeneration: false,
      tts: false,
      embeddings: false,
    },
    async chatCompletion() {
      return { text: '', usage: { estimated: true }, model: 'test' };
    },
    async *streamChatCompletion() {
      yield '';
      return { text: '', usage: { estimated: true }, model: 'test' };
    },
    async scoreAutoEngage() {
      return {
        shouldReply: false,
        confidence: 0,
        reason: 'test',
        suggestedTone: 'neutral',
        risk: 'low' as const,
      };
    },
    jsonCompletion: structured as LLMProvider['jsonCompletion'],
  } satisfies LLMProvider;
  return { llm, structured };
}

function validDraft() {
  return {
    version: 1 as const,
    summary: 'Add a deterministic helper and its regression coverage.',
    files: [
      {
        path: 'src/example.ts',
        operation: 'replace' as const,
        content: 'export const answer = 42;\n',
      },
      {
        path: 'tests/example.test.ts',
        operation: 'create' as const,
        content: "import { expect, it } from 'vitest';\nit('works', () => expect(42).toBe(42));\n",
      },
    ],
    verificationNotes: ['Run the repository test and typecheck stages.'],
  };
}

const proposalFiles: LocalDevelopmentCandidateFile[] = [
  { path: 'src/example.ts', kind: 'regular', content: 'export const answer = 41;\n' },
  { path: 'tests/example.test.ts', kind: 'new', content: '' },
];

describe('LocalDevelopmentModel proposal generation', () => {
  it('uses the authenticated structured provider and returns complete allowlisted files', async () => {
    const controller = new AbortController();
    const { llm, structured } = providerWith(async (request) => {
      const parsed = request.schema.safeParse(validDraft());
      return parsed.success ? parsed.data : null;
    });
    const model = new LocalDevelopmentModel(llm);

    await expect(
      model.propose({
        goal: 'Update the deterministic answer and add a regression test.',
        files: proposalFiles,
        model: 'nvidia/nemotron-large',
        signal: controller.signal,
      }),
    ).resolves.toEqual(validDraft());

    expect(structured).toHaveBeenCalledTimes(1);
    const request = structured.mock.calls[0]?.[0];
    expect(request?.model).toBe('nvidia/nemotron-large');
    expect(request?.signal).toBe(controller.signal);
    expect(request?.system).toContain('no tools, shell, filesystem or network access');
    expect(request?.prompt).toContain('src/example.ts');
    expect(request?.prompt).toContain('export const answer = 41');
    expect(request?.schemaHint).toContain('src/example.ts=replace');
    expect(request?.schemaHint).toContain('tests/example.test.ts=create');
  });

  it('validates provider output again even if a provider skips its schema contract', async () => {
    const cases = [
      {
        ...validDraft(),
        files: [
          {
            path: 'src/not-allowed.ts',
            operation: 'replace',
            content: 'export const nope = true;',
          },
        ],
      },
      {
        ...validDraft(),
        files: [
          { path: 'src/example.ts', operation: 'create', content: 'export const answer = 42;' },
        ],
      },
      {
        ...validDraft(),
        files: [
          {
            path: 'src/example.ts',
            operation: 'replace',
            content: proposalFiles[0]?.content ?? '',
          },
        ],
      },
      {
        ...validDraft(),
        files: [
          { path: '../outside.ts', operation: 'replace', content: 'export const nope = true;' },
        ],
      },
    ];

    for (const value of cases) {
      const { llm } = providerWith(async () => value);
      const model = new LocalDevelopmentModel(llm);
      await expect(
        model.propose({ goal: 'Make a valid local code change.', files: proposalFiles }),
      ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({
        code: 'generation_failed',
      });
    }
  });

  it('rejects secret-bearing generated content and duplicate output paths', async () => {
    const unsafe = {
      ...validDraft(),
      files: [
        {
          path: 'src/example.ts',
          operation: 'replace',
          content: 'export const API_TOKEN = "secret-value-123456789";\n',
        },
        {
          path: 'src/example.ts',
          operation: 'replace',
          content: 'export const other = true;\n',
        },
      ],
    };
    const { llm } = providerWith(async () => unsafe);

    await expect(
      new LocalDevelopmentModel(llm).propose({
        goal: 'Make a valid local code change.',
        files: proposalFiles,
      }),
    ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({
      code: 'generation_failed',
      message: 'The development model returned an invalid or unsafe proposal.',
    });
  });

  it('never sends secrets from goals or candidate contents to the provider', async () => {
    const { llm, structured } = providerWith(async () => validDraft());
    const model = new LocalDevelopmentModel(llm);

    await expect(
      model.propose({
        goal: 'Use API_TOKEN=secret-value-123456789 to update the route.',
        files: proposalFiles,
      }),
    ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({ code: 'invalid_input' });
    await expect(
      model.propose({
        goal: 'Update the route safely.',
        files: [
          {
            path: 'src/example.ts',
            kind: 'regular',
            content: 'const API_TOKEN = "secret-value-123456789";',
          },
        ],
      }),
    ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({ code: 'invalid_input' });
    expect(structured).not.toHaveBeenCalled();
  });

  it('bounds and redacts verifier feedback before it enters the prompt', async () => {
    const { llm, structured } = providerWith(async (request) => {
      const parsed = request.schema.safeParse(validDraft());
      return parsed.success ? parsed.data : null;
    });
    const rawToken = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const errors = [
      `request failed with ${rawToken}`,
      'first\nline\u0000second',
      ...Array.from({ length: 10 }, (_, index) => `error-${index}-${'x'.repeat(500)}`),
    ];

    await new LocalDevelopmentModel(llm).propose({
      goal: 'Repair the verified implementation.',
      files: proposalFiles,
      feedback: errors,
    });

    const prompt = structured.mock.calls[0]?.[0].prompt ?? '';
    const parsed = JSON.parse(prompt) as { verificationErrors: string[] };
    expect(prompt).not.toContain(rawToken);
    expect(parsed.verificationErrors).toHaveLength(LOCAL_DEVELOPMENT_LIMITS.verificationErrors);
    expect(parsed.verificationErrors[0]).toContain('[redacted]');
    expect(parsed.verificationErrors.every((entry) => entry.length <= 300)).toBe(true);
    expect(parsed.verificationErrors[1]).toBe('first line second');
  });

  it('rejects traversal, symlinks, duplicate candidates and aggregate overflow before prompting', async () => {
    const { llm, structured } = providerWith(async () => validDraft());
    const invalidSets: LocalDevelopmentCandidateFile[][] = [
      [{ path: 'src/../outside.ts', kind: 'regular', content: 'export {};' }],
      [{ path: '/src/outside.ts', kind: 'regular', content: 'export {};' }],
      [{ path: 'src/linked.ts', kind: 'symlink', content: '' }],
      [{ path: 'tests/not-a-test.ts', kind: 'new', content: '' }],
      [
        { path: 'src/a.ts', kind: 'regular', content: 'export {};' },
        { path: 'src/a.ts', kind: 'regular', content: 'export {};' },
      ],
      [
        {
          path: 'src/huge.ts',
          kind: 'regular',
          content: 'x'.repeat(LOCAL_DEVELOPMENT_LIMITS.candidateFileChars + 1),
        },
      ],
    ];

    for (const files of invalidSets) {
      await expect(
        new LocalDevelopmentModel(llm).propose({
          goal: 'Make a valid local code change.',
          files,
        }),
      ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({ code: 'invalid_input' });
    }
    expect(structured).not.toHaveBeenCalled();
  });

  it('forwards cancellation and does not call an unavailable chat route', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('cancelled by caller'));
    const available = providerWith(async () => validDraft());
    await expect(
      new LocalDevelopmentModel(available.llm).propose({
        goal: 'Make a valid local code change.',
        files: proposalFiles,
        signal: aborted.signal,
      }),
    ).rejects.toThrow('cancelled by caller');
    expect(available.structured).not.toHaveBeenCalled();

    const unavailable = providerWith(async () => validDraft(), false);
    await expect(
      new LocalDevelopmentModel(unavailable.llm).propose({
        goal: 'Make a valid local code change.',
        files: proposalFiles,
      }),
    ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({ code: 'chat_unavailable' });
    expect(unavailable.structured).not.toHaveBeenCalled();
  });

  it('does not expose provider error details', async () => {
    const privateDetail = 'API_TOKEN=secret-value-123456789';
    const { llm } = providerWith(async () => {
      throw new Error(privateDetail);
    });
    const error = await new LocalDevelopmentModel(llm)
      .propose({ goal: 'Make a valid local code change.', files: proposalFiles })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LocalDevelopmentModelError);
    expect(String((error as Error).message)).not.toContain(privateDetail);
    expect(error).toMatchObject({ code: 'generation_failed' });
  });
});

describe('LocalDevelopmentModel catalog selection', () => {
  it('selects only catalog paths and safe bounded search terms', async () => {
    const controller = new AbortController();
    const selection = {
      paths: ['src/services/linkMedia.ts', 'tests/linkMediaService.test.ts'],
      newPaths: ['src/services/mediaLimitNotice.ts', 'tests/mediaLimitNotice.test.ts'],
      searchTerms: ['duration_exceeded', 'maxDurationSeconds'],
      reason: 'The service owns duration policy and its regression coverage.',
    };
    const { llm, structured } = providerWith(async (request) => {
      const parsed = request.schema.safeParse(selection);
      return parsed.success ? parsed.data : null;
    });
    const model = new LocalDevelopmentModel(llm);

    await expect(
      model.selectFiles({
        goal: 'Improve over-limit video awareness.',
        catalog: [
          'src/services/linkMedia.ts',
          'src/providers/media/linkMedia/ytdlp.ts',
          'tests/linkMediaService.test.ts',
        ],
        model: 'gemini-large',
        signal: controller.signal,
      }),
    ).resolves.toEqual(selection);

    const request = structured.mock.calls[0]?.[0];
    expect(request?.model).toBe('gemini-large');
    expect(request?.signal).toBe(controller.signal);
    expect(request?.prompt).toContain('src/providers/media/linkMedia/ytdlp.ts');
    expect(request?.system).toContain('never commands or command-line flags');
  });

  it('rejects selections outside the catalog, unsafe terms and duplicate values', async () => {
    const outputs = [
      {
        paths: ['src/unknown.ts'],
        newPaths: [],
        searchTerms: ['duration'],
        reason: 'Looks relevant.',
      },
      {
        paths: ['src/example.ts'],
        newPaths: [],
        searchTerms: ['--glob'],
        reason: 'Looks relevant.',
      },
      {
        paths: ['src/example.ts', 'src/example.ts'],
        newPaths: [],
        searchTerms: [],
        reason: 'Looks relevant.',
      },
      {
        paths: [],
        newPaths: ['src/example.ts'],
        searchTerms: [],
        reason: 'Create it.',
      },
      {
        paths: [],
        newPaths: ['tests/not-a-test.ts'],
        searchTerms: [],
        reason: 'Create it.',
      },
    ];

    for (const output of outputs) {
      const { llm } = providerWith(async () => output);
      await expect(
        new LocalDevelopmentModel(llm).selectFiles({
          goal: 'Find the relevant implementation.',
          catalog: ['src/example.ts'],
        }),
      ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({
        code: 'selection_failed',
      });
    }
  });

  it('rejects unsafe or duplicate catalog paths before prompting', async () => {
    const { llm, structured } = providerWith(async () => ({
      paths: ['src/example.ts'],
      newPaths: [],
      searchTerms: [],
      reason: 'Relevant.',
    }));
    const model = new LocalDevelopmentModel(llm);

    for (const catalog of [
      ['src/../secret.ts'],
      ['src/example.js'],
      ['src/example.ts', 'src/example.ts'],
      [],
    ]) {
      await expect(
        model.selectFiles({ goal: 'Find relevant files.', catalog }),
      ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({ code: 'invalid_input' });
    }
    expect(structured).not.toHaveBeenCalled();
  });
});

describe('LocalDevelopmentModel structured review', () => {
  const diff = [
    'diff --git a/src/example.ts b/src/example.ts',
    '--- a/src/example.ts',
    '+++ b/src/example.ts',
    '@@ -1 +1 @@',
    '-export const answer = 41;',
    '+export const answer = 42;',
  ].join('\n');

  it('reviews a bounded diff without tools and validates issue paths against it', async () => {
    const controller = new AbortController();
    const review = {
      version: 1 as const,
      verdict: 'approved' as const,
      summary: 'The visible change is coherent with the goal.',
      issues: [],
    };
    const { llm, structured } = providerWith(async (request) => {
      const parsed = request.schema.safeParse(review);
      return parsed.success ? parsed.data : null;
    });

    await expect(
      new LocalDevelopmentModel(llm).review({
        goal: 'Correct the deterministic answer.',
        diff,
        model: 'review-model',
        signal: controller.signal,
      }),
    ).resolves.toEqual(review);

    const request = structured.mock.calls[0]?.[0];
    expect(request?.model).toBe('review-model');
    expect(request?.signal).toBe(controller.signal);
    expect(request?.system).toContain('no tools, shell, filesystem or network access');
    expect(request?.prompt).toContain('export const answer = 42');
  });

  it('removes full Git object ids from review prompts without allowing long hex source content', async () => {
    const review = {
      version: 1 as const,
      verdict: 'approved' as const,
      summary: 'The visible change is coherent with the goal.',
      issues: [],
    };
    const { llm, structured } = providerWith(async (request) => {
      const parsed = request.schema.safeParse(review);
      return parsed.success ? parsed.data : null;
    });
    const fullIndexDiff = [
      'diff --git a/src/example.ts b/src/example.ts',
      `index ${'a'.repeat(40)}..${'b'.repeat(40)} 100644`,
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1 @@',
      '-export const answer = 41;',
      '+export const answer = 42;',
    ].join('\n');

    await expect(
      new LocalDevelopmentModel(llm).review({
        goal: 'Correct the deterministic answer.',
        diff: fullIndexDiff,
      }),
    ).resolves.toEqual(review);
    const prompt = structured.mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('index [git-object]..[git-object]');
    expect(prompt).not.toContain('a'.repeat(40));

    await expect(
      new LocalDevelopmentModel(llm).review({
        goal: 'Correct the deterministic answer.',
        diff: `${diff}\n+export const suspicious = '${'c'.repeat(40)}';`,
      }),
    ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({ code: 'invalid_input' });
  });

  it('rejects contradictory reviews and issue paths absent from the diff', async () => {
    const reviews = [
      {
        version: 1,
        verdict: 'approved',
        summary: 'Approved despite a blocker.',
        issues: [{ severity: 'error', path: 'src/example.ts', message: 'Concrete blocker.' }],
      },
      {
        version: 1,
        verdict: 'changes_requested',
        summary: 'No concrete blocker supplied.',
        issues: [{ severity: 'warning', path: 'src/example.ts', message: 'Optional thought.' }],
      },
      {
        version: 1,
        verdict: 'changes_requested',
        summary: 'A blocker exists elsewhere.',
        issues: [{ severity: 'error', path: 'src/other.ts', message: 'Concrete blocker.' }],
      },
    ];
    for (const value of reviews) {
      const { llm } = providerWith(async () => value);
      await expect(
        new LocalDevelopmentModel(llm).review({
          goal: 'Correct the deterministic answer.',
          diff,
        }),
      ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({ code: 'review_failed' });
    }
  });

  it('does not send a secret-bearing or oversized diff to the provider', async () => {
    const { llm, structured } = providerWith(async () => ({
      version: 1,
      verdict: 'approved',
      summary: 'Fine.',
      issues: [],
    }));
    const model = new LocalDevelopmentModel(llm);

    await expect(
      model.review({
        goal: 'Review the change safely.',
        diff: `${diff}\n+const API_TOKEN = "secret-value-123456789";`,
      }),
    ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({ code: 'invalid_input' });
    await expect(
      model.review({
        goal: 'Review the change safely.',
        diff: 'x'.repeat(LOCAL_DEVELOPMENT_LIMITS.diffChars + 1),
      }),
    ).rejects.toMatchObject<Partial<LocalDevelopmentModelError>>({ code: 'invalid_input' });
    expect(structured).not.toHaveBeenCalled();
  });
});

describe('local development schemas', () => {
  it('exposes strict standalone schemas and safe path validation', () => {
    expect(isSafeLocalDevelopmentPath('src/foo/bar.ts')).toBe(true);
    expect(isSafeLocalDevelopmentPath('tests/foo.test.ts')).toBe(true);
    expect(isSafeLocalDevelopmentPath('src//foo.ts')).toBe(false);
    expect(isSafeLocalDevelopmentPath('src/.hidden.ts')).toBe(false);
    expect(isSafeLocalDevelopmentPath('README.md')).toBe(false);
    expect(isSafeNewLocalDevelopmentPath('src/newFeature.ts')).toBe(true);
    expect(isSafeNewLocalDevelopmentPath('tests/newFeature.test.ts')).toBe(true);
    expect(isSafeNewLocalDevelopmentPath('tests/newFeature.ts')).toBe(false);
    expect(
      localDevelopmentDraftSchema.safeParse({ ...validDraft(), unexpected: true }).success,
    ).toBe(false);
    expect(
      localDevelopmentSelectionSchema.safeParse({
        paths: [],
        newPaths: [],
        searchTerms: [],
        reason: 'Nothing selected.',
      }).success,
    ).toBe(false);
  });
});
