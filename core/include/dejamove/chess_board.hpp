#pragma once

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace dejamove {

enum class Side { White, Black };

enum class GameStatus { Ongoing, Check, Checkmate, Stalemate, Draw };

struct MoveInfo {
    std::string uci;
    std::string san;
    std::string from;
    std::string to;
    std::string promotion;
};

struct MoveResult {
    std::string uci;
    std::string san;
    std::string fen;
    std::string normalized_fen;
    GameStatus status = GameStatus::Ongoing;
};

/**
 * @brief Encapsulates chess board state, legal move generation, and FEN/UCI/SAN conversions.
 */
class ChessBoard {
  public:
    ChessBoard();
    ~ChessBoard();

    ChessBoard(const ChessBoard& other);
    ChessBoard& operator=(const ChessBoard& other);
    ChessBoard(ChessBoard&&) noexcept;
    ChessBoard& operator=(ChessBoard&&) noexcept;

    /**
     * @brief Parses a FEN string into a ChessBoard, returning std::nullopt if invalid.
     */
    static std::optional<ChessBoard> from_fen(std::string_view fen);

    /**
     * @brief Returns the full FEN string for the current position.
     */
    [[nodiscard]] std::string fen() const;

    /**
     * @brief Returns the normalized FEN (first 4 fields: pieces, side, castling, ep)
     * for transposition matching regardless of halfmove/fullmove counters.
     */
    [[nodiscard]] std::string normalized_fen() const;

    [[nodiscard]] Side side_to_move() const;
    [[nodiscard]] GameStatus status() const;

    [[nodiscard]] bool is_legal_uci(std::string_view uci) const;
    [[nodiscard]] std::vector<MoveInfo> legal_moves() const;

    /**
     * @brief Applies a UCI move if legal and returns move metadata + resulting position info.
     */
    std::optional<MoveResult> make_uci_move(std::string_view uci);

    /**
     * @brief Applies a SAN move if legal and returns move metadata + resulting position info.
     */
    std::optional<MoveResult> make_san_move(std::string_view san);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dejamove
