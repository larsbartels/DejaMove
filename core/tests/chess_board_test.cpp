#include "dejamove/chess_board.hpp"

#include <catch2/catch_test_macros.hpp>

using dejamove::ChessBoard;
using dejamove::GameStatus;
using dejamove::Side;

TEST_CASE("ChessBoard starts at standard initial position", "[chess_board]") {
    ChessBoard board;
    REQUIRE(board.side_to_move() == Side::White);
    REQUIRE(board.status() == GameStatus::Ongoing);
    REQUIRE(board.legal_moves().size() == 20);
    REQUIRE(board.is_legal_uci("e2e4"));
    REQUIRE_FALSE(board.is_legal_uci("e2e5"));
}

TEST_CASE("ChessBoard applies UCI and SAN moves and detects checkmate", "[chess_board]") {
    ChessBoard board;
    REQUIRE(board.make_san_move("e4").has_value());
    REQUIRE(board.side_to_move() == Side::Black);
    REQUIRE(board.make_uci_move("e7e5").has_value());
    REQUIRE(board.make_san_move("Qh5").has_value());
    REQUIRE(board.make_san_move("Nc6").has_value());
    REQUIRE(board.make_san_move("Bc4").has_value());
    REQUIRE(board.make_san_move("Nf6").has_value());

    const auto mate = board.make_san_move("Qxf7#");
    REQUIRE(mate.has_value());
    REQUIRE(mate->uci == "h5f7");
    REQUIRE(mate->san == "Qxf7#");
    REQUIRE(mate->status == GameStatus::Checkmate);
}

TEST_CASE("ChessBoard normalized_fen matches across transpositions", "[chess_board]") {
    ChessBoard line_a;
    REQUIRE(line_a.make_san_move("d4").has_value());
    REQUIRE(line_a.make_san_move("d5").has_value());
    REQUIRE(line_a.make_san_move("c4").has_value());
    REQUIRE(line_a.make_san_move("e6").has_value());

    ChessBoard line_b;
    REQUIRE(line_b.make_san_move("c4").has_value());
    REQUIRE(line_b.make_san_move("e6").has_value());
    REQUIRE(line_b.make_san_move("d4").has_value());
    REQUIRE(line_b.make_san_move("d5").has_value());

    REQUIRE(line_a.normalized_fen() == line_b.normalized_fen());
}

TEST_CASE("ChessBoard supports promotions and rejects invalid FENs", "[chess_board]") {
    auto promo_board = ChessBoard::from_fen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
    REQUIRE(promo_board.has_value());
    const auto res = promo_board->make_uci_move("a7a8q");
    REQUIRE(res.has_value());
    REQUIRE(res->san == "a8=Q+");
    REQUIRE(res->status == GameStatus::Check);

    REQUIRE_FALSE(ChessBoard::from_fen("not-a-valid-fen").has_value());
}

TEST_CASE("ChessBoard parses 4-field FENs and trims surrounding whitespace", "[chess_board]") {
    auto board =
        ChessBoard::from_fen("  rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -  \n");
    REQUIRE(board.has_value());
    REQUIRE(board->side_to_move() == Side::White);
    REQUIRE(board->normalized_fen() == "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -");
    REQUIRE(board->make_san_move("Nf3").has_value());

    REQUIRE_FALSE(ChessBoard::from_fen("   \t\n ").has_value());
}
