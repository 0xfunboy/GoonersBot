# AGENTS.md — Repository Guidance & Behavioral Constraints

## Repository Architecture & Guidelines
- Language & Runtime: TypeScript (ESM) on Node.js (pinned via `.nvmrc`).
- Core service: `systemd` user service `goonerbot.service`.
- Frameworks: `grammY` (Telegram bot), `better-sqlite3` (storage), local AI/ComfyUI/Stable Diffusion/TTS/STT providers.
- Architecture:
  - Central DI Container: `src/services/index.ts`.
  - Intent Dispatcher: Cortex (`src/brain/cortex/`).
  - Terminal Capabilities & DAG Execution: AgentRuntime (`src/services/agentRuntime.ts`).
  - Conversational Pipeline: `src/services/reply.ts`.

## Execution Constraints & Anti-Blocking Rules
1. **Never Hang on Shell / Git Invocations**:
   - Always run Git commands with `--no-optional-locks` and `--ignore-submodules=all`.
   - Never let Git hang on credential or SSH prompts: prefix commands with `GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"`.
   - Always wrap git network or scan commands with `timeout <seconds>`:
     - Example: `timeout 15 git --no-optional-locks status --ignore-submodules=all`
     - Example: `timeout 30 git push origin HEAD`
2. **Never Propose `cd`**:
   - Always specify the working directory using `Cwd: "/home/funboy/goonerbot"`.
3. **Prefer Native Filesystem Tools**:
   - For all inspections, listings, searches, and file modifications, use native tools (`list_dir`, `view_file`, `grep_search`, `replace_file_content`, `write_to_file`).
