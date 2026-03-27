# AI_OPERATIONS_MANUAL.md

## 1. The Danger of Global Linting
**Never use `--auto-test` with global scope commands** (e.g., `npx eslint app/`). Running global linters triggers the "Whack-A-Mole" effect: the AI agent will detect legacy technical debt in untouched files, attempt to fix everything blindly, and quickly exhaust its safety limits (reflections), shutting down to prevent massive token drain. **Use the native `--lint` flag instead**. This restricts the AI's validation strictly to the files it modified during the current task, maintaining isolation and protecting your budget.

## 2. Forcing Context (The `type` Trick)
When Aider refuses or fails to load tracking files via command-line arguments, **bypass the restriction using terminal standard output**. Execute the command `type BACKLOG.md` directly within the Aider prompt. This forces the console to print the raw text into the chat, physically injecting the file's entire content into the agent's active RAM/context and allowing it to proceed without permission roadblocks.

## 3. The Search/Replace Limitation
Aider frequently fails with a `SearchReplaceNoExactMatch` error because it attempts to patch code using outdated or assumed file structures. If formatting, spacing, or imports differ by a single character, the patch will safely abort. **Strict Protocol:** Before allowing Aider to generate a `SEARCH/REPLACE` block, explicitly instruct it to **READ the exact current content of the target file**. Do not allow blind guessing; the agent must see the live code structure before attempting a rewrite.

## 4. The Next.js Server/Client Trap
Aider is prone to making fatal architectural errors in the Next.js App Router, specifically by **injecting client-side React hooks (`useState`, `useTransition`, `onClick`) directly into async Server Components like `page.tsx`**. This will instantly crash the Turbopack compiler. **Absolute Rule:** Force the agent to extract any interactive UI elements (tables, buttons, state) into separate, dedicated child components explicitly prefixed with the `'use client'` directive. Keep `page.tsx` as a pure server-side data fetcher.

## 5. The RAM Reset Rule
Never leave an Aider session running continuously across multiple tasks. Extended sessions suffer from "Context Rot," leading to token bloat, hallucinated variables, and forgotten system prompts. **Enforce the strict isolation protocol:** Open Aider -> Execute exactly one ticket -> Commit the changes -> Shut down the agent using `/exit` -> Restart Aider for the next task. This clears the active RAM and forces the agent to read the freshest "Liquid Memory" directly from the Git repository.