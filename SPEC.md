# DejaMove — Comprehensive Task & Design Specification

> **Status:** High-Level Specification (Tech Stack & Implementation Details TBD)  
> **Goal:** A standalone desktop chess opening repetition trainer with a modular, extensible architecture.

---

## 1. Vision & Core Principles

**DejaMove** is a standalone chess opening move repetition trainer designed around deliberate, tree/graph-based repertoire building, adaptive spaced-repetition training, and seamless engine-assisted analysis.

### Architectural Principles

- **Modular by Design:** Core domain logic (chess rules, repertoire graph, scoring/scheduling, engine communication, persistence) must be strictly decoupled from the GUI framework so any layer can be swapped, extended, or tested independently.
- **Graph-First Repertoire Model:** Openings naturally branch and transpose. The data model must support both **automatic splitting** of lines and **multiple parents per child variant** (a Directed Acyclic Graph, or DAG) without special-case hacks.
- **Non-Disruptive UX:** Training mistakes should teach rather than punish with hard resets; analysis should connect directly to the live training state and back.

---

## 2. High-Level Module Architecture

The system should be structured into six loosely coupled modules communicating via clean interfaces/events:

1. **Chess Rules & Board State Module**
   - Legal move generation and validation (castling, en passant, promotions, check/checkmate/stalemate).
   - FEN / move notation (UCI & SAN) conversion and position normalization (for transposition/lookup).
   - Move history stack (undo/redo, navigate to start/end, branch exploration).
2. **Repertoire Graph & Variant Management Module**
   - Manages move nodes, variant segments, parent-child DAG edges, names, and move descriptions.
   - Handles automatic splitting on branch creation and merging/linking when a line reaches an existing variant (multi-parent support).
3. **Training & Knowledge Scoring Engine**
   - Runs training sessions (single variant, child variant, or weighted random).
   - Tracks per-variant knowledge scores, per-move response times, failure flags, and time-based score decay.
4. **Analysis & Chess Engine Adapter**
   - Position-based lookup of repertoire continuations (for red arrows).
   - Engine-agnostic UCI interface (Stockfish) behind a toggleable service (eval score/bar + top $N$ moves for blue arrows).
5. **Persistence & Serialization Module**
   - Versioned local storage for repertoires, training statistics, and user preferences.
   - Designed to support future import/export formats (e.g., PGN, JSON backups).
6. **GUI & Application Shell**
   - Standalone desktop wrapper + interactive board, variant tree/graph viewer, editor controls, trainer HUD, and analysis panel.

---

## 3. Detailed Functional Requirements

### 3.1 Interactive Chess Board & Controls

- **Legal Chess Rules:** Enforce full FIDE rules; disallow illegal moves.
- **Intuitive Input:**
  - Drag-and-drop piece movement.
  - Click-source, click-destination movement.
  - Pawn promotion selection UI.
- **Navigation:**
  - Keyboard arrow keys (`Left` / `Right` to step backward/forward through move history when available; `Home` / `End` optional).
  - On-screen navigation buttons and clickable move list.
- **Board Perspective & Overlays:**
  - Flip board orientation (automatically matches variant side in Trainer/Editor, freely flippable in Analysis).
  - Support layered, color-coded board arrows (e.g., **red** for repertoire moves, **blue** for engine moves, **green/amber** for training feedback) and square highlights.

---

### 3.2 Repertoire & Variant Management (DAG Model)

#### Variant Structure

- **Perspective:** Each variant is defined for either **White** or **Black**.
- **Starting Position:**
  - Can start from the standard initial chess position or any **custom board position** built via the GUI (board editor: place/remove pieces, set side to move, castling rights, en passant).
- **Flexible Depth & Branching:**
  - Variants have arbitrary depth and branching factor; different variants can have completely different shapes.
- **Metadata:**
  - Every variant has a **name** (user-editable; auto-generated sensible default on split).
  - Every move in a variant can optionally carry a **description / comment**.

#### GUI-Based Creation & Editing

- Users create and edit variants directly on the GUI board:
  1. Choose side (White / Black) and starting position (default or custom setup).
  2. Play moves step-by-step on the board to extend the line or create branches.
  3. Edit names, move descriptions, or prune/modify branches at any point.

#### Automatic Splitting & Multi-Parent DAG Behavior

- **Automatic Splitting:**
  - If a variant `A -> B -> C -> D` exists, and the user later defines `B -> E -> G` (a new continuation from the position after `B`), the repertoire automatically splits at `B`:
    - Parent variant: `A -> B`
    - Child variant 1: `C -> D`
    - Child variant 2: `E -> G`
  - After `A -> B`, both `C` and `E` are valid continuations in the repertoire.
- **Multiple Parents (Transpositions / Shared Subtrees):**
  - A child variant may have **more than one parent variant** (e.g., two different move orders `Parent1` and `Parent2` that converge into the same child variant `Child`).
  - The repertoire is therefore a **Directed Acyclic Graph (DAG)** of variant segments rather than a strict tree.
  - **Cycle Prevention:** Adding an edge that would create a cycle in the variant graph must be prevented/rejected cleanly.
  - **Path-Independent Identity:** `Child` maintains its own identity, name, move descriptions, and knowledge score regardless of which parent led into it.

---

### 3.3 Core Training Feature

#### Training Flow

1. **Position Presentation:** The trainer loads the starting position of the chosen variant (or child variant) and prompts the user whenever it is the user's turn to move.
2. **Opponent Moves:** Opponent moves in the variant are played automatically by the trainer (with clear visual indication).
3. **Branching During Training:**
   - If the **opponent** has multiple defined responses, the trainer selects one (e.g., prioritizing lower-scored child branches or randomizing).
   - If the **user** has multiple valid continuations at a position, **any** defined repertoire move at that node is accepted as correct; the trainer continues down the branch corresponding to the move the user played.
4. **Starting Point Flexibility:**
   - Training can start from a root variant (e.g., `A`) and flow through into a child variant (e.g., `A -> B -> C -> D`).
   - Training can also start **directly at a child variant** (e.g., starting at the position right before `C` or `E`).

#### Wrong Move Handling

- If the user plays a move that is **not** a valid continuation in the active variant/branch:
  - The trainer **does not abort or reset** the line.
  - The mistake is indicated visually, and **arrow(s)** are drawn showing what the correct move option(s) would have been.
  - The trainer then **continues** the variant (advancing along the expected move so the user practices the rest of the line).
  - The active variant (and/or segment where the mistake occurred) is marked as **failed** for scoring purposes.

#### Knowledge Score & Scheduling

- **Per-Variant Knowledge Score:**
  - Each variant (including each child variant) maintains its own knowledge score and training metadata (`lastPracticedAt`, `attempts`, `streak`, etc.).
  - **Path-Scoped Updates:** Completing `A -> B -> C -> D` updates the scores for `A -> B` and `C -> D`, while leaving sibling `E -> G` (and any other unvisited parent of `C -> D`) untouched.
  - **Success:** Increases the knowledge score. Solving moves **quickly** (measured per move of the variant) awards a larger score increase than slow/hesitant solves.
  - **Failure:** Decreases the knowledge score.
  - **Time Decay:** Knowledge scores decay slowly over time when a variant is not practiced (computed dynamically or via elapsed time since last practice).
- **Training Selection Modes:**
  - **Manual Selection:** User picks a specific variant (or child variant) to train.
  - **Smart Random Mode:** Selects variants/positions probabilistically, strongly preferring those with a **low current knowledge score** (accounting for time decay).

---

### 3.4 Analysis Board & Trainer Integration

#### Analysis Board Capabilities

- **Free Exploration:** Users can make any legal move on the board, explore arbitrary sidelines, and step backward/forward freely.
- **Repertoire Overlay (Red Arrows):**
  - At any position on the analysis board, display **red arrows** for all moves that exist in the defined variants from that position.
  - Lookup should be position-based so repertoire moves are highlighted even if the user reached the position via a non-standard move order.
- **Chess Engine Integration (Stockfish, Toggleable):**
  - Can be switched **On / Off** at any time.
  - Displays a **position evaluation bar** (centipawn / mate score).
  - Displays **blue arrows** for the top $N$ engine moves (with $N$ configurable, e.g., 1–5).

#### Seamless Trainer ↔ Analysis Handoff

- **Trainer → Analysis:**
  - A button in the Trainer is available at any moment to open the Analysis Board.
  - Opens the Analysis Board at the **exact current position** from the Trainer, **preserving the move history** back to the variant's initial position so the user can step backward to see how the position arose.
- **Analysis → Trainer:**
  - A button in the Analysis Board returns **straight back to the Trainer** and resumes the exact paused training session where the user left off.

---

### 3.5 Standalone Application & Persistence

- Must run as a **standalone desktop application** (no external server or manual terminal setup required for end users).
- All variants, graph relationships, move descriptions, and training scores must persist locally between sessions.

---

## 4. Extensibility & Anticipated Future Changes

To keep future change requests low-friction, the design should explicitly preserve clean extension points for:

- **Graph & Variant Operations:** Merging duplicate positions across variants, reordering/renaming child variants, tagging/grouping variants into repertoires/folders.
- **Scoring & SRS Algorithms:** Pluggable scoring strategy interface (so decay curves, speed bonus weights, or FSRS/SM-2-style scheduling can be tuned or swapped without touching UI/storage).
- **Import / Export:** PGN import (parsing trees/variations into the DAG) and PGN/JSON export.
- **Training Modes:** Drill-until-mastered loops, timed blitz drills, or "only practice branches where I previously failed."
- **Engine Settings:** Configurable Stockfish depth/time/threads, or swapping in a native external UCI binary.

---

## 5. Initial Tech Stack (Reversible)

Because the domain logic and UI are decoupled behind a clean protocol boundary, any layer below can be swapped later if needed:

- **Backend (`dejamove-core`):** **C++20 + CMake**
  - Owns chess rules/FEN/SAN/UCI, the Repertoire DAG (auto-splitting & multi-parent support), training & scoring/decay engine, local JSON persistence, and Stockfish UCI process management.
  - Exposes a **JSON-RPC over stdin/stdout** interface to the frontend and is independently unit-testable.
- **Frontend (`dejamove-ui`):** **Electron + React + TypeScript + Vite + `chessground`**
  - Kept intentionally thin: renders the interactive board (drag-and-drop, click-to-move, arrow overlays), evaluation bar, variant graph/list, and mode controls, delegating all domain decisions to `dejamove-core`.
- **Chess Engine:** **Stockfish** managed via native UCI over stdin/stdout from the C++ backend.
- **Standalone Packaging:** **`electron-builder`** bundling the UI, compiled `dejamove-core` binary, and Stockfish into a standalone desktop executable.

---

## 6. Remaining TBD Decisions

- **Exact Scoring Formula:** Numerical bounds, decay half-life, and per-move speed thresholds.
- **Stockfish Distribution:** Bundled binary vs. user-configured path (or both).
- **UI Layout & Visual Design:** Exact panel arrangement, themes, sound effects, and board styles.
