#include "dejamove/uci_engine.hpp"

#include <catch2/catch_test_macros.hpp>

using dejamove::Side;
using dejamove::UciEngine;

TEST_CASE("UCI parser normalizes centipawn and mate scores to White's perspective",
          "[uci_engine]") {
    const std::string cp_line =
        "info depth 16 seldepth 22 multipv 2 score cp -145 nodes 12000 pv c7c5 g1f3";
    const auto white_view = dejamove::parse_uci_info_line(cp_line, Side::White);
    REQUIRE(white_view.has_value());
    REQUIRE(white_view->multipv == 2);
    REQUIRE(white_view->depth == 16);
    REQUIRE_FALSE(white_view->eval.is_mate);
    REQUIRE(white_view->eval.centipawns == -145);
    REQUIRE(white_view->pv_uci == std::vector<std::string>{"c7c5", "g1f3"});

    // From Black to move, -145 cp for Black means +145 cp for White.
    const auto black_view = dejamove::parse_uci_info_line(cp_line, Side::Black);
    REQUIRE(black_view.has_value());
    REQUIRE(black_view->eval.centipawns == 145);

    const std::string mate_line = "info depth 20 multipv 1 score mate 3 pv d1h5";
    const auto mate_black = dejamove::parse_uci_info_line(mate_line, Side::Black);
    REQUIRE(mate_black.has_value());
    REQUIRE(mate_black->eval.is_mate);
    REQUIRE(mate_black->eval.mate_in == -3);
}

TEST_CASE("UCI parser ignores non-PV info lines and unconfigured engine fails gracefully",
          "[uci_engine]") {
    REQUIRE_FALSE(dejamove::parse_uci_info_line("info string NNUE evaluation using", Side::White)
                      .has_value());
    REQUIRE_FALSE(
        dejamove::parse_uci_info_line("info depth 10 currmove e2e4", Side::White).has_value());

    UciEngine engine;
    REQUIRE_FALSE(engine.is_available());
    const auto res = engine.analyze("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    REQUIRE_FALSE(res.ok);
    REQUIRE_FALSE(res.error.empty());
}
