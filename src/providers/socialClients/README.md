# Social client boundary

This directory is a non-networking scaffold for future X, Instagram, Facebook, TikTok and YouTube
clients. It does not log in, scrape, download or publish anything yet, and it is not wired into the
Telegram bot. Existing deterministic link-media extraction remains independent.

## Security invariants

- Read and write adapters use different TypeScript interfaces and registry slots.
- `SocialClientGateway` is the only intended execution boundary. Handlers and learned capabilities
  must not invoke adapters directly.
- The default policy is deny-all. Writes additionally require a global enable switch plus exact
  principal, platform, action and logical-account allowlists.
- Every adapter action must be declared `available` in its capability manifest. The built-in
  platform manifests are only a roadmap: reads are `planned`, writes are `disabled`.
- Credentials are references only. A cookie jar is referenced through the name of an environment
  variable containing its mounted path; a managed secret uses an opaque provider/id reference.
  Passwords, cookie values, OAuth tokens and browser storage state do not belong in requests,
  manifests, logs or this repository.
- Audit records deliberately omit input/output payloads, URLs, credential references and
  idempotency keys.
- Writes require idempotency keys. Adapter errors leave the key `uncertain`, preventing a blind
  retry that could duplicate a post or reaction.
- The included rate limiter, audit sink and idempotency store are in-memory development
  implementations. Durable shared replacements are mandatory before enabling writes in production.

The local `.gitignore` is a second guard against common cookie/session filenames, but it is not a
secret-management mechanism. Keep jars outside the source tree, mode `0600`, and mount them into the
service account. Rotate any credential that was ever pasted into chat, logs or source control.

## Layout

- `types.ts`: platforms, read/write action sets, request and adapter contracts.
- `manifest.ts`: manifest validation and deliberately non-executable platform roadmap.
- `credentials.ts`: strict validation of secret and cookie-jar references.
- `cookieJars.ts`: explicit Netscape-jar import, domain filtering and per-platform references.
- `registry.ts`: separate read/write adapter registration and capability enforcement.
- `policy.ts`: principal/platform/action/account allowlists and per-action rate limits.
- `idempotency.ts`: write claim/replay/uncertain contract plus a development store.
- `audit.ts`: payload-free event schema and development sink.
- `gateway.ts`: policy, capability, rate, audit and idempotency orchestration.

## Adding the first read adapter

1. Implement `SocialReadAdapter` for one platform and the smallest useful action, normally
   `session.validate`, `content.metadata.read` or `content.media.resolve`.
2. Mark only that implemented action `available` in the adapter's own manifest. Do not mutate the
   roadmap manifest.
3. Resolve the credential reference through an injected deployment-specific resolver. Never read a
   password from source/config and never emit cookies in errors.
4. Apply the same network-isolation, redirect validation, DNS pinning, response-size and timeout
   controls already required by link-media before consuming untrusted URLs.
5. Register the adapter and construct an explicit `SocialPolicyEngine` allowlist for trusted
   principals. Add contract tests using mocked network responses before any live-account test.

## Preparing per-platform cookie jars

Use a separate, low-privilege browser profile containing only the bot's social accounts. Export a
Netscape-format jar manually to a temporary file, close the browser, and set that source file to mode
`0600`. Do not point this code at a normal personal Chrome/Chromium/Firefox profile: the importer has
no profile discovery and accepts only the explicit exported file path supplied by an operator.

`importNetscapeCookieJar` filters the export to the platform's domain boundaries, strips arbitrary
comments, rejects malformed rows and atomically installs a `0600` destination. For example, a setup
tool outside the running bot can call:

```ts
await importNetscapeCookieJar({
  platform: 'x',
  sourcePath: '/secure/operator-export/x.cookies.txt',
  destinationPath: '/home/service/.local/share/goonerbot/social-sessions/x.cookies.txt',
});
```

Configure only the resulting path via the corresponding environment variable:

| Platform  | Path environment variable          |
| --------- | ---------------------------------- |
| X         | `SOCIAL_X_COOKIE_JAR_FILE`         |
| Instagram | `SOCIAL_INSTAGRAM_COOKIE_JAR_FILE` |
| Facebook  | `SOCIAL_FACEBOOK_COOKIE_JAR_FILE`  |
| TikTok    | `SOCIAL_TIKTOK_COOKIE_JAR_FILE`    |
| YouTube   | `SOCIAL_YOUTUBE_COOKIE_JAR_FILE`   |

The first import refuses to overwrite an existing jar. Set `overwrite: true` only during an
intentional rotation after validating the source. Delete the temporary export securely afterwards;
the importer intentionally does not delete operator-owned input. Keep the destination directory out
of Git and backups that are not designed for secrets.

## Enabling writes later

Posting is a separate phase. Before registering a `SocialWriteAdapter`, provide a durable audit sink,
a durable atomic idempotency store, a shared rate limiter, an operator approval/reconciliation flow,
and per-account action allowlists. Use official APIs/OAuth where available and respect platform
terms, consent, privacy, and rate limits. Keep `write.enabled` false until those controls are deployed
and tested. Destructive actions such as `post.delete` should also require a fresh, explicit operator
confirmation outside this generic gateway.
