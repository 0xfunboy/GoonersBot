# Telegram Local Bot API in GoonersBot

GoonersBot usa il server ufficiale [`tdlib/telegram-bot-api`](https://github.com/tdlib/telegram-bot-api) in modalità `--local` per superare il limite di upload del Bot API cloud e inviare file anime/video grandi come **un singolo file Telegram**, senza split o transcode distruttivi.

## Come è versionato

Il sorgente upstream è incluso come **git submodule pinned**:

```text
third_party/telegram-bot-api
```

Il repository principale salva soltanto il commit Git esatto da usare. TDLib rimane il submodule annidato dell'upstream e viene inizializzato con `--recursive`. Non vengono versionati:

- `third_party/telegram-bot-api/build/` e altri object/cache di compilazione;
- il binario installato `~/.local/bin/telegram-bot-api`;
- `api_id` / `api_hash`;
- dati runtime e file temporanei Telegram.

Per inizializzare una clone esistente:

```bash
git submodule update --init --recursive
```

## Build e installazione

Il setup versionato è:

```bash
pnpm telegram-api:setup
# equivalente:
bash scripts/setup-telegram-bot-api.sh
```

Lo script:

1. inizializza il submodule pinned;
2. verifica toolchain C/C++, OpenSSL, zlib, `cmake`, `gperf` e `make`;
3. compila Release in `third_party/telegram-bot-api/build/`;
4. installa il binario in `~/.local/bin/telegram-bot-api`;
5. installa `ops/systemd/telegram-bot-api.service` come user service;
6. crea, se manca, `~/.config/goonerbot/telegram-bot-api.env` con permessi `0600`.

Le credenziali applicative Telegram ottenute da `my.telegram.org/apps` vanno esclusivamente nel file locale:

```env
TELEGRAM_API_ID=<id>
TELEGRAM_API_HASH=<hash>
```

Non vanno mai salvate in `.env.example`, Git o nel submodule.

## Runtime

Il servizio versionato ascolta soltanto su localhost:

```text
127.0.0.1:8081
```

con dati runtime in:

```text
~/.local/share/telegram-bot-api/data
~/.local/share/telegram-bot-api/tmp
```

GoonersBot si collega tramite:

```env
TELEGRAM_API_ROOT=http://127.0.0.1:8081
```

`ops/systemd/goonerbot.service` dichiara `After=` e `Wants=` su `telegram-bot-api.service`, quindi il backend Telegram locale viene avviato prima del bot.

## Aggiornamento upstream

Un aggiornamento è intenzionale e reviewabile:

```bash
cd third_party/telegram-bot-api
git fetch origin
git checkout <commit-verificato>
cd ../..
git add third_party/telegram-bot-api
git commit -m "chore: update Telegram Bot API"
```

Dopo il cambio di commit va ricompilato con `pnpm telegram-api:setup`. Non seguire automaticamente `master` in produzione: il pin nel repository rende build e deploy riproducibili.
