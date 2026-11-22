import type { EngineLine, Side } from '../types';

interface EvalBarProps {
  topLine?: EngineLine;
  orientation: Side;
  enabled: boolean;
}

function formatEval(line?: EngineLine): string {
  if (!line) return '0.0';
  if (line.isMate) {
    return line.mateIn > 0 ? `M${line.mateIn}` : `-M${Math.abs(line.mateIn)}`;
  }
  const pawns = line.centipawns / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

function computeWhitePercent(line?: EngineLine): number {
  if (!line) return 50;
  if (line.isMate) {
    return line.mateIn > 0 ? 98 : 2;
  }
  // Smooth logistic curve mapping centipawns to [4%, 96%]
  const sig = 2 / (1 + Math.exp(-0.004 * line.centipawns)) - 1;
  return Math.max(4, Math.min(96, 50 + 46 * sig));
}

export function EvalBar({ topLine, orientation, enabled }: EvalBarProps) {
  const whitePct = enabled ? computeWhitePercent(topLine) : 50;
  const label = enabled ? formatEval(topLine) : 'Off';

  return (
    <div className={`eval-bar ${orientation === 'black' ? 'flipped' : ''} ${enabled ? '' : 'off'}`}>
      <div className="eval-fill-white" style={{ height: `${whitePct}%` }} />
      <span className="eval-label">{label}</span>
    </div>
  );
}
