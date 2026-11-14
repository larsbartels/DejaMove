#include "dejamove/chess_board.hpp"

#include <chess.hpp>
#include <sstream>

namespace dejamove {

namespace {

std::string normalize_fen_string(std::string_view full_fen) {
    // Keep only the first 4 space-delimited FEN fields:
    // placement, active color, castling availability, en passant target.
    std::istringstream iss{std::string(full_fen)};
    std::string pieces;
    std::string side;
    std::string castling;
    std::string ep;
    if (!(iss >> pieces >> side >> castling >> ep)) {
        return std::string(full_fen);
    }
    return pieces + " " + side + " " + castling + " " + ep;
}

GameStatus compute_status(const chess::Board& board) {
    auto [reason, result] = board.isGameOver();
    if (result != chess::GameResult::NONE) {
        if (reason == chess::GameResultReason::CHECKMATE) {
            return GameStatus::Checkmate;
        }
        if (reason == chess::GameResultReason::STALEMATE) {
            return GameStatus::Stalemate;
        }
        return GameStatus::Draw;
    }
    if (board.inCheck()) {
        return GameStatus::Check;
    }
    return GameStatus::Ongoing;
}

MoveInfo to_move_info(const chess::Board& board, chess::Move move) {
    const std::string uci = chess::uci::moveToUci(move);
    const std::string san = chess::uci::moveToSan(board, move);
    std::string promotion;
    if (uci.size() == 5) {
        promotion = uci.substr(4, 1);
    }
    return MoveInfo{
        .uci = uci,
        .san = san,
        .from = uci.substr(0, 2),
        .to = uci.substr(2, 2),
        .promotion = promotion,
    };
}

} // namespace

struct ChessBoard::Impl {
    chess::Board board;
};

ChessBoard::ChessBoard() : impl_(std::make_unique<Impl>()) {}

ChessBoard::~ChessBoard() = default;

ChessBoard::ChessBoard(const ChessBoard& other) : impl_(std::make_unique<Impl>(*other.impl_)) {}

ChessBoard& ChessBoard::operator=(const ChessBoard& other) {
    if (this != &other) {
        *impl_ = *other.impl_;
    }
    return *this;
}

ChessBoard::ChessBoard(ChessBoard&&) noexcept = default;
ChessBoard& ChessBoard::operator=(ChessBoard&&) noexcept = default;

std::optional<ChessBoard> ChessBoard::from_fen(std::string_view fen) {
    ChessBoard result;
    if (!result.impl_->board.setFen(fen)) {
        return std::nullopt;
    }
    return result;
}

std::string ChessBoard::fen() const {
    return impl_->board.getFen();
}

std::string ChessBoard::normalized_fen() const {
    return normalize_fen_string(impl_->board.getFen());
}

Side ChessBoard::side_to_move() const {
    return impl_->board.sideToMove() == chess::Color::WHITE ? Side::White : Side::Black;
}

GameStatus ChessBoard::status() const {
    return compute_status(impl_->board);
}

bool ChessBoard::is_legal_uci(std::string_view uci) const {
    const chess::Move move = chess::uci::uciToMove(impl_->board, uci);
    if (move == chess::Move::NO_MOVE) {
        return false;
    }
    chess::Movelist legal;
    chess::movegen::legalmoves(legal, impl_->board);
    return std::find(legal.begin(), legal.end(), move) != legal.end();
}

std::vector<MoveInfo> ChessBoard::legal_moves() const {
    chess::Movelist legal;
    chess::movegen::legalmoves(legal, impl_->board);
    std::vector<MoveInfo> result;
    result.reserve(legal.size());
    for (const auto& move : legal) {
        result.push_back(to_move_info(impl_->board, move));
    }
    return result;
}

std::optional<MoveResult> ChessBoard::make_uci_move(std::string_view uci) {
    const chess::Move move = chess::uci::uciToMove(impl_->board, uci);
    if (move == chess::Move::NO_MOVE) {
        return std::nullopt;
    }
    chess::Movelist legal;
    chess::movegen::legalmoves(legal, impl_->board);
    if (std::find(legal.begin(), legal.end(), move) == legal.end()) {
        return std::nullopt;
    }

    const std::string san = chess::uci::moveToSan(impl_->board, move);
    const std::string canonical_uci = chess::uci::moveToUci(move);
    impl_->board.makeMove(move);

    const std::string new_fen = impl_->board.getFen();
    return MoveResult{
        .uci = canonical_uci,
        .san = san,
        .fen = new_fen,
        .normalized_fen = normalize_fen_string(new_fen),
        .status = compute_status(impl_->board),
    };
}

std::optional<MoveResult> ChessBoard::make_san_move(std::string_view san) {
    const chess::Move move = chess::uci::parseSan(impl_->board, san);
    if (move == chess::Move::NO_MOVE) {
        return std::nullopt;
    }
    const std::string canonical_san = chess::uci::moveToSan(impl_->board, move);
    const std::string canonical_uci = chess::uci::moveToUci(move);
    impl_->board.makeMove(move);

    const std::string new_fen = impl_->board.getFen();
    return MoveResult{
        .uci = canonical_uci,
        .san = canonical_san,
        .fen = new_fen,
        .normalized_fen = normalize_fen_string(new_fen),
        .status = compute_status(impl_->board),
    };
}

} // namespace dejamove
