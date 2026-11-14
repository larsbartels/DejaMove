# DejaMove

**DejaMove** is a standalone desktop chess opening move repetition trainer with a DAG-based repertoire editor, adaptive spaced-repetition training, and Stockfish-assisted analysis.

See [SPEC.md](./SPEC.md) for the full architecture and feature specification.

---

## Architecture Overview

- **`core/`** _(planned)_ — **C++20 + CMake** backend (`dejamove-core`): chess rules, repertoire DAG (auto-splitting & multi-parent transpositions), training & knowledge scoring/decay, local persistence, and Stockfish UCI integration via JSON-RPC over stdin/stdout.
- **`ui/`** _(planned)_ — **Electron + React + TypeScript + `chessground`** frontend (`dejamove-ui`): interactive board, arrow overlays, evaluation bar, and mode views.

---

## Development Setup

### Prerequisites

- **Node.js & npm** (for linting, formatting, and the Electron/React UI)
- **CMake** and a **C++20 compiler** (e.g., Visual Studio 2022 Build Tools / MSVC, Clang, or GCC)
- **clang-format / clang-tidy** (included with Visual Studio 2022 Build Tools LLVM or standalone LLVM)

### First-Time Setup

```sh
npm install
npm run setup:hooks
```

`npm run setup:hooks` configures Git to use the version-controlled hooks in [`.githooks/`](./.githooks/):

- **`pre-commit`**: Checks C++ formatting (`clang-format`), JS/TS/JSON/CSS/MD formatting (`prettier`), and TypeScript linting (`eslint`) on staged files.
- **`pre-push`**: Runs C++ unit tests (`ctest` when `core/build` exists) and UI typecheck/lint (when `ui/` exists).

### Useful Commands

```sh
npm run lint          # Run ESLint across the repo
npm run format        # Format JS/TS/JSON/CSS/MD files with Prettier
npm run format:check  # Check formatting without modifying files
```
