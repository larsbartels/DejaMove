#include "dejamove/training_engine.hpp"

#include <algorithm>
#include <catch2/catch_test_macros.hpp>
#include <cstdint>

using dejamove::ChessBoard;
using dejamove::RepertoireGraph;
using dejamove::Side;
using dejamove::TrainingEngine;

namespace {

constexpr std::int64_t kMsPerDay = 86'400'000;

} // namespace

TEST_CASE("Completing a path scores visited parent and child while leaving siblings untouched",
          "[training_engine]") {
    RepertoireGraph graph;
    const std::string init_fen = ChessBoard().fen();

    // A-B-C-D: 1. e4 e5 2. Nf3 Nc6
    const auto r1 = graph.add_variant("King's Knight", Side::White, init_fen,
                                      {{"e4"}, {"e5"}, {"Nf3"}, {"Nc6"}});
    REQUIRE(r1.ok);

    // Split after 1. e4 e5 with 2. Bc4 Nf6
    const auto r2 = graph.add_variant("Bishop's Opening", Side::White, init_fen,
                                      {{"e4"}, {"e5"}, {"Bc4"}, {"Nf6"}});
    REQUIRE(r2.ok);
    REQUIRE(r2.split_occurred);

    const std::string parent_id = r2.split_parent_id;
    const auto* parent = graph.find_segment(parent_id);
    REQUIRE(parent != nullptr);
    REQUIRE(parent->child_ids.size() == 2);

    const std::string child_nf3_id = parent->child_ids[0];
    const std::string child_bc4_id = parent->child_ids[1];

    TrainingEngine engine;
    std::mt19937_64 rng(42);
    const std::int64_t now = 1'000'000'000;

    auto session_opt = engine.start_session(graph, parent_id, rng);
    REQUIRE(session_opt.has_value());
    auto session = *session_opt;

    // Play 1. e4 (auto-plays 1... e5)
    auto res1 = engine.submit_move(graph, session, "e4", 1200, now, rng);
    REQUIRE(res1.accepted);
    REQUIRE(res1.correct);
    session = res1.state;
    REQUIRE_FALSE(session.completed);

    // At the branch point, play 2. Nf3 (auto-plays 2... Nc6 and finishes)
    auto res2 = engine.submit_move(graph, session, "Nf3", 1200, now, rng);
    REQUIRE(res2.accepted);
    REQUIRE(res2.correct);
    REQUIRE(res2.state.completed);

    REQUIRE(graph.find_segment(parent_id)->stats.score > 0.0);
    REQUIRE(graph.find_segment(child_nf3_id)->stats.score > 0.0);
    REQUIRE(graph.find_segment(child_bc4_id)->stats.score == 0.0);
}

TEST_CASE("Trainer can start directly at a child variant", "[training_engine]") {
    RepertoireGraph graph;
    const std::string init_fen = ChessBoard().fen();

    REQUIRE(
        graph.add_variant("Line 1", Side::White, init_fen, {{"e4"}, {"e5"}, {"Nf3"}, {"Nc6"}}).ok);
    const auto r2 =
        graph.add_variant("Line 2", Side::White, init_fen, {{"e4"}, {"e5"}, {"Bc4"}, {"Nf6"}});
    REQUIRE(r2.ok);

    TrainingEngine engine;
    std::mt19937_64 rng(7);
    const std::int64_t now = 1'000'000'000;

    auto session_opt = engine.start_session(graph, r2.segment_id, rng);
    REQUIRE(session_opt.has_value());
    auto session = *session_opt;

    // Should start after 1. e4 e5, awaiting White's 2. Bc4
    const auto res = engine.submit_move(graph, session, "Bc4", 1000, now, rng);
    REQUIRE(res.accepted);
    REQUIRE(res.correct);
    REQUIRE(res.state.completed);
    REQUIRE(graph.find_segment(r2.segment_id)->stats.score > 0.0);
    REQUIRE(graph.find_segment(r2.split_parent_id)->stats.attempts == 0);
}

TEST_CASE("Wrong move shows expected options, continues the line, and penalizes score",
          "[training_engine]") {
    RepertoireGraph graph;
    const std::string init_fen = ChessBoard().fen();

    const auto r =
        graph.add_variant("Italian", Side::White, init_fen, {{"e4"}, {"e5"}, {"Nf3"}, {"Nc6"}});
    REQUIRE(r.ok);

    // Give the variant an initial positive score so a failure visibly lowers it.
    graph.find_segment_mut(r.segment_id)->stats.score = 60.0;
    graph.find_segment_mut(r.segment_id)->stats.attempts = 1;
    graph.find_segment_mut(r.segment_id)->stats.last_practiced_ms = 1'000'000'000;

    TrainingEngine engine;
    std::mt19937_64 rng(11);
    const std::int64_t now = 1'000'000'000;

    auto session = *engine.start_session(graph, r.segment_id, rng);

    // Play wrong move 1. d4 instead of 1. e4
    const auto wrong = engine.submit_move(graph, session, "d4", 1500, now, rng);
    REQUIRE(wrong.accepted);
    REQUIRE_FALSE(wrong.correct);
    REQUIRE(wrong.expected_moves.size() == 1);
    REQUIRE(wrong.expected_moves[0].san == "e4");
    session = wrong.state;
    REQUIRE(session.awaiting_mistake_advance);

    // Continue past the mistake -> auto-plays 1. e4 and 1... e5, now awaiting 2. Nf3
    session = engine.advance_after_mistake(graph, session, now, rng);
    REQUIRE_FALSE(session.awaiting_mistake_advance);
    REQUIRE_FALSE(session.completed);

    // Finish the rest of the variant correctly
    const auto finish = engine.submit_move(graph, session, "Nf3", 1000, now, rng);
    REQUIRE(finish.accepted);
    REQUIRE(finish.correct);
    REQUIRE(finish.state.completed);

    // Variant still counts as failed and score decreases from 60.0
    REQUIRE(graph.find_segment(r.segment_id)->stats.score < 60.0);
    REQUIRE(graph.find_segment(r.segment_id)->stats.streak == 0);
}

TEST_CASE("Faster solves earn higher scores and scores decay over time", "[training_engine]") {
    TrainingEngine engine;
    const std::int64_t t0 = 1'000'000'000;

    RepertoireGraph fast_graph;
    RepertoireGraph slow_graph;
    const std::string init_fen = ChessBoard().fen();
    const auto f = fast_graph.add_variant("Fast", Side::White, init_fen, {{"e4"}, {"e5"}});
    const auto s = slow_graph.add_variant("Slow", Side::White, init_fen, {{"e4"}, {"e5"}});

    std::mt19937_64 rng(99);
    auto fs = *engine.start_session(fast_graph, f.segment_id, rng);
    auto ss = *engine.start_session(slow_graph, s.segment_id, rng);

    REQUIRE(engine.submit_move(fast_graph, fs, "e4", 800, t0, rng).state.completed);
    REQUIRE(engine.submit_move(slow_graph, ss, "e4", 15000, t0, rng).state.completed);

    const double fast_score = fast_graph.find_segment(f.segment_id)->stats.score;
    const double slow_score = slow_graph.find_segment(s.segment_id)->stats.score;
    REQUIRE(fast_score > slow_score);

    // Effective score decays over 14 days
    const double decayed =
        engine.effective_score(fast_graph.find_segment(f.segment_id)->stats, t0 + 14 * kMsPerDay);
    REQUIRE(decayed < fast_score);
}

TEST_CASE("Smart random mode prefers lower-scored variants", "[training_engine]") {
    RepertoireGraph graph;
    const std::string init_fen = ChessBoard().fen();

    const auto strong = graph.add_variant("Mastered", Side::White, init_fen, {{"e4"}, {"e5"}});
    const auto weak = graph.add_variant("Needs Work", Side::White, init_fen, {{"d4"}, {"d5"}});

    const std::int64_t now = 1'000'000'000;
    auto* strong_seg = graph.find_segment_mut(strong.segment_id);
    strong_seg->stats.score = 95.0;
    strong_seg->stats.attempts = 5;
    strong_seg->stats.last_practiced_ms = now;

    TrainingEngine engine;
    std::mt19937_64 rng(123);
    int weak_picks = 0;
    for (int i = 0; i < 100; ++i) {
        const auto* picked = engine.pick_smart_random_segment(graph, now, std::nullopt, rng);
        REQUIRE(picked != nullptr);
        if (picked->id == weak.segment_id) {
            ++weak_picks;
        }
    }
    REQUIRE(weak_picks > 85);
}
