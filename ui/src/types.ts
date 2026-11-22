export type Side = 'white' | 'black';

export type GameStatus = 'ongoing' | 'check' | 'checkmate' | 'stalemate' | 'draw';

export interface LegalMove {
  uci: string;
  san: string;
  from: string;
  to: string;
  promotion: string;
}

export interface BoardStateResponse {
  valid: boolean;
  error?: string;
  fen: string;
  normalizedFen: string;
  sideToMove: Side;
  status: GameStatus;
  legalMoves: LegalMove[];
  uci?: string;
  san?: string;
}

export interface BoardArrow {
  orig: string;
  dest: string;
  brush: 'red' | 'blue' | 'green' | 'yellow';
}

export interface MoveStep {
  uci: string;
  san: string;
  fen: string;
  normalizedFen: string;
  description: string;
}

export interface VariantStats {
  score: number;
  attempts: number;
  successes: number;
  streak: number;
  lastPracticedMs: number;
}

export interface VariantSegment {
  id: string;
  name: string;
  side: Side;
  startFen: string;
  startNormalizedFen: string;
  moves: MoveStep[];
  parentIds: string[];
  childIds: string[];
  stats: VariantStats;
  effectiveScore?: number;
}

export interface RepertoireListResponse {
  schemaVersion: number;
  nextId: number;
  segments: VariantSegment[];
}

export interface AddVariantResponse {
  ok: boolean;
  error?: string;
  segmentId: string;
  splitOccurred: boolean;
  splitParentId: string;
}

export interface PlayedMoveRecord {
  uci: string;
  san: string;
  fen: string;
  description: string;
  bySide: Side;
  isUserMove: boolean;
  wasMistake: boolean;
}

export interface ExpectedMoveOption {
  uci: string;
  san: string;
  description: string;
  targetSegmentId: string;
  targetPlyIndex: number;
}

export interface SegmentScoreDelta {
  segmentId: string;
  name: string;
  passed: boolean;
  previousScore: number;
  newScore: number;
}

export interface TrainingSessionState {
  active: boolean;
  completed: boolean;
  awaitingMistakeAdvance: boolean;
  startSegmentId: string;
  currentSegmentId: string;
  currentSegmentName: string;
  userSide: Side;
  startFen: string;
  currentFen: string;
  sideToMove: Side;
  legalMoves: LegalMove[];
  history: PlayedMoveRecord[];
  pendingExpectedMoves: ExpectedMoveOption[];
  scoreDeltas: SegmentScoreDelta[];
}

export interface TrainingStartResponse {
  ok: boolean;
  error?: string;
  session?: TrainingSessionState;
}

export interface TrainingSubmitResponse {
  accepted: boolean;
  correct: boolean;
  error?: string;
  expectedMoves: ExpectedMoveOption[];
  session: TrainingSessionState;
}

export interface ContinuationOption {
  uci: string;
  san: string;
  segmentId: string;
  plyIndex: number;
  description: string;
}

export interface EngineLine {
  multipv: number;
  depth: number;
  isMate: boolean;
  centipawns: number;
  mateIn: number;
  pvUci: string[];
}

export interface AnalysisPly {
  fen: string;
  sideToMove: Side;
  legalMoves: LegalMove[];
  uci?: string;
  san?: string;
}

export type PositionMatchKind = 'start' | 'interior' | 'end';

export interface PositionMatch {
  segmentId: string;
  name: string;
  side: Side;
  plyIndex: number;
  matchKind: PositionMatchKind;
  moveSan: string;
  nextMoveSan: string;
  effectiveScore: number;
}

export interface FindByFenResponse {
  ok: boolean;
  error?: string;
  fen?: string;
  normalizedFen?: string;
  sideToMove?: Side;
  matches: PositionMatch[];
}

export interface EditorTargetLocation {
  segmentId: string;
  plyIndex: number;
  nonce: number;
}

declare global {
  interface Window {
    dejamove: {
      rpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
    };
  }
}
