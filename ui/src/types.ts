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

declare global {
  interface Window {
    dejamove: {
      rpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
    };
  }
}
