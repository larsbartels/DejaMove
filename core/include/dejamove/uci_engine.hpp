#pragma once

#include "dejamove/chess_board.hpp"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace dejamove {

struct UciEval {
    bool is_mate = false;
    int centipawns = 0; // Normalized to White's perspective (+ = White better, - = Black better)
    int mate_in = 0;    // Normalized to White's perspective (+ = White mates, - = Black mates)
};

struct UciLine {
    int multipv = 1;
    int depth = 0;
    UciEval eval;
    std::vector<std::string> pv_uci;
};

struct AnalysisResult {
    bool ok = false;
    std::string error;
    std::string fen;
    std::vector<UciLine> lines;
};

/**
 * @brief Parses a single UCI `info ...` line into a UciLine, normalizing scores to White's
 * perspective. Returns std::nullopt if the line does not contain both a score and a PV.
 */
[[nodiscard]] std::optional<UciLine> parse_uci_info_line(std::string_view line, Side side_to_move);

/**
 * @brief Manages an optional external native UCI chess engine process (e.g. Stockfish).
 */
class UciEngine {
  public:
    UciEngine() = default;

    bool configure(std::string engine_path, int threads = 1);
    [[nodiscard]] bool is_available() const;
    [[nodiscard]] const std::string& engine_path() const {
        return engine_path_;
    }

    [[nodiscard]] AnalysisResult analyze(std::string_view fen, int multi_pv = 3, int depth = 14,
                                         int move_time_ms = 800) const;

  private:
    std::string engine_path_;
    int threads_ = 1;
};

} // namespace dejamove
