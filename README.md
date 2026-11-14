# DejaMove

**DejaMove** is a standalone desktop chess opening move repetition trainer with a DAG-based repertoire editor, adaptive spaced-repetition training, and Stockfish-assisted analysis.

See [SPEC.md](./SPEC.md) for the full architecture and feature specification.

---

## Architecture Overview

- **`core/`** — **C++20 + CMake** backend (`dejamove-core`): chess rules, repertoire DAG (auto-splitting & multi-parent transpositions), training & knowledge scoring/decay, local JSON persistence, and UCI engine adapter via JSON-RPC over stdin/stdout.
- **`ui/`** — **Electron + React + TypeScript + `chessground`** frontend (`dejamove-ui`): interactive board, arrow overlays, Stockfish WASM evaluation bar, and Repertoire Editor / Trainer / Analysis Board views.

---

## Development Setup

### Prerequisites

- **Node.js & npm** (for linting, formatting, and the Electron/React UI)
- **CMake** and a **C++20 compiler** (e.g., Visual Studio 2022 Build Tools / MSVC + Windows SDK)
- **clang-format / clang-tidy** (included with Visual Studio 2022 Build Tools LLVM or standalone LLVM)

### First-Time Setup

```sh
npm install
npm run setup:hooks
npm --prefix ui install
```

`npm run setup:hooks` configures Git to use the version-controlled hooks in [`.githooks/`](./.githooks/):

- **`pre-commit`**: Checks C++ formatting (`clang-format`), JS/TS/JSON/CSS/MD formatting (`prettier`), and TypeScript linting (`eslint`) on staged files.
- **`pre-push`**: Runs C++ unit tests (`ctest` when `core/build` exists) and UI typecheck/lint (when `ui/` exists).

### Build, Test & Run

```sh
# 1. Build & test C++ core
cmake -S core -B core/build
cmake --build core/build --config Debug
ctest --test-dir core/build -C Debug --output-on-failure

# 2. Run desktop app in development mode
npm --prefix ui run dev

# 3. Package standalone Windows portable executable (outputs to ui/release/)
cmake --build core/build --config Release --target dejamove-core
npm --prefix ui run package
```

### Useful Commands

```sh
npm run lint          # Run ESLint across the repo
npm run format        # Format JS/TS/JSON/CSS/MD files with Prettier
npm run format:check  # Check formatting without modifying files
```
