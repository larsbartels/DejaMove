#include "dejamove/repertoire_graph.hpp"

#include <algorithm>
#include <catch2/catch_test_macros.hpp>

using dejamove::ChessBoard;
using dejamove::MoveInput;
using dejamove::RepertoireGraph;
using dejamove::Side;

namespace {

bool contains_san(const std::vector<dejamove::Continuation>& conts, std::string_view san) {
    return std::any_of(conts.begin(), conts.end(), [&](const auto& c) { return c.san == san; });
}

bool contains_id(const std::vector<std::string>& ids, std::string_view id) {
    return std::find(ids.begin(), ids.end(), id) != ids.end();
}

} // namespace

TEST_CASE(
    "Adding a diverging line automatically splits an existing variant into parent and children",
    "[repertoire_graph]") {
    RepertoireGraph graph;
    const std::string initial_fen = ChessBoard().fen();

    // First define A-B-C-D: 1. e4 e5 2. Nf3 Nc6
    const auto r1 = graph.add_variant("King's Knight", Side::White, initial_fen,
                                      {{"e4", "Control center"}, {"e5"}, {"Nf3"}, {"Nc6"}});
    REQUIRE(r1.ok);
    REQUIRE(graph.size() == 1);

    // Position right after A (1. e4)
    ChessBoard after_e4;
    REQUIRE(after_e4.make_san_move("e4").has_value());

    // Later define B-E-G: 1... e5 2. Bc4 Nf6
    const auto r2 = graph.add_variant("Bishop's Opening", Side::White, after_e4.fen(),
                                      {{"e5"}, {"Bc4", "Target f7"}, {"Nf6"}});
    REQUIRE(r2.ok);
    REQUIRE(r2.split_occurred);
    REQUIRE(graph.size() == 3);

    const auto* parent = graph.find_segment(r2.split_parent_id);
    REQUIRE(parent != nullptr);
    REQUIRE(parent->moves.size() == 2);
    REQUIRE(parent->moves[0].san == "e4");
    REQUIRE(parent->moves[1].san == "e5");
    REQUIRE(parent->child_ids.size() == 2);

    // After 1. e4 e5, both 2. Nf3 and 2. Bc4 are valid repertoire continuations.
    const std::string after_e4_e5_norm = RepertoireGraph::end_normalized_fen(*parent);
    const auto conts = graph.continuations_at(after_e4_e5_norm);
    REQUIRE(conts.size() == 2);
    REQUIRE(contains_san(conts, "Nf3"));
    REQUIRE(contains_san(conts, "Bc4"));
}

TEST_CASE("A child variant can have multiple parents via transpositions", "[repertoire_graph]") {
    RepertoireGraph graph;
    const std::string initial_fen = ChessBoard().fen();

    // Two move orders reaching the Queen's Gambit Declined position
    const auto p1 =
        graph.add_variant("QGD via d4", Side::White, initial_fen, {{"d4"}, {"d5"}, {"c4"}, {"e6"}});
    const auto p2 =
        graph.add_variant("QGD via c4", Side::White, initial_fen, {{"c4"}, {"e6"}, {"d4"}, {"d5"}});
    REQUIRE(p1.ok);
    REQUIRE(p2.ok);

    const auto* seg1 = graph.find_segment(p1.segment_id);
    const auto* seg2 = graph.find_segment(p2.segment_id);
    REQUIRE(seg1 != nullptr);
    REQUIRE(seg2 != nullptr);

    const std::string qgd_fen = RepertoireGraph::end_fen(*seg1);
    const auto child = graph.add_variant("QGD Mainline", Side::White, qgd_fen, {{"Nc3"}, {"Nf6"}});
    REQUIRE(child.ok);

    REQUIRE(graph.link_parent_child(seg1->id, child.segment_id).ok);
    REQUIRE(graph.link_parent_child(seg2->id, child.segment_id).ok);

    const auto* child_seg = graph.find_segment(child.segment_id);
    REQUIRE(child_seg != nullptr);
    REQUIRE(child_seg->parent_ids.size() == 2);
    REQUIRE(contains_id(child_seg->parent_ids, seg1->id));
    REQUIRE(contains_id(child_seg->parent_ids, seg2->id));
}

TEST_CASE("Linking rejects cycles and mismatched board positions", "[repertoire_graph]") {
    RepertoireGraph graph;
    const std::string initial_fen = ChessBoard().fen();

    const auto root = graph.add_variant("Root", Side::White, initial_fen, {{"e4"}, {"e5"}});
    REQUIRE(root.ok);

    // Self-loop must be rejected
    REQUIRE_FALSE(graph.link_parent_child(root.segment_id, root.segment_id).ok);

    // Mismatched position must be rejected
    const auto other = graph.add_variant("Other", Side::White, initial_fen, {{"d4"}, {"d5"}});
    REQUIRE(other.ok);
    REQUIRE_FALSE(graph.link_parent_child(root.segment_id, other.segment_id).ok);
}

TEST_CASE("Variants support renaming, move descriptions, and clean removal", "[repertoire_graph]") {
    RepertoireGraph graph;
    const std::string initial_fen = ChessBoard().fen();

    const auto r1 = graph.add_variant("Initial Name", Side::Black, initial_fen, {{"e4"}, {"c5"}});
    REQUIRE(r1.ok);
    REQUIRE(graph.rename_variant(r1.segment_id, "Sicilian Defense"));
    REQUIRE(graph.set_move_description(r1.segment_id, 1, "Asymmetrical counterattack"));

    const auto* seg = graph.find_segment(r1.segment_id);
    REQUIRE(seg->name == "Sicilian Defense");
    REQUIRE(seg->moves[1].description == "Asymmetrical counterattack");

    const auto child = graph.branch_from(r1.segment_id, 1, "Open Sicilian", {{"Nf3"}, {"d6"}});
    REQUIRE(child.ok);
    REQUIRE(graph.remove_variant(child.segment_id));
    REQUIRE(graph.find_segment(child.segment_id) == nullptr);
    REQUIRE(graph.find_segment(r1.segment_id)->child_ids.empty());
}

TEST_CASE("find_positions_by_fen locates start, interior, end, and transposed matches",
          "[repertoire_graph]") {
    RepertoireGraph graph;
    const std::string init_fen = ChessBoard().fen();

    // Split parent 1. e4 e5 into two children: 2. Nf3 Nc6 and 2. Bc4 Nf6
    const auto r1 = graph.add_variant("King's Knight", Side::White, init_fen,
                                      {{"e4"}, {"e5"}, {"Nf3"}, {"Nc6"}});
    const auto r2 = graph.add_variant("Bishop's Opening", Side::White, init_fen,
                                      {{"e4"}, {"e5"}, {"Bc4"}, {"Nf6"}});
    REQUIRE(r1.ok);
    REQUIRE(r2.ok);
    REQUIRE(r2.split_occurred);

    const std::string parent_id = r2.split_parent_id;
    const auto* parent = graph.find_segment(parent_id);
    REQUIRE(parent != nullptr);

    // 1. Start position of parent
    const auto start_matches =
        graph.find_positions_by_fen(ChessBoard::from_fen(init_fen)->normalized_fen());
    REQUIRE(start_matches.size() == 1);
    REQUIRE(start_matches[0].segment_id == parent_id);
    REQUIRE(start_matches[0].ply_index == 0);
    REQUIRE(start_matches[0].match_kind == dejamove::PositionMatchKind::Start);
    REQUIRE(start_matches[0].next_move_san == "e4");

    // 2. Interior position of parent (after 1. e4) matched regardless of halfmove/fullmove clocks
    ChessBoard after_e4;
    REQUIRE(after_e4.make_san_move("e4").has_value());
    const auto interior_matches = graph.find_positions_by_fen(after_e4.normalized_fen());
    REQUIRE(interior_matches.size() == 1);
    REQUIRE(interior_matches[0].segment_id == parent_id);
    REQUIRE(interior_matches[0].ply_index == 1);
    REQUIRE(interior_matches[0].match_kind == dejamove::PositionMatchKind::Interior);
    REQUIRE(interior_matches[0].move_san == "e4");
    REQUIRE(interior_matches[0].next_move_san == "e5");

    // 3. Branch boundary (after 1. e4 e5): matches end of parent AND start of both children
    const auto boundary_matches =
        graph.find_positions_by_fen(RepertoireGraph::end_normalized_fen(*parent));
    REQUIRE(boundary_matches.size() == 3);
    REQUIRE(std::any_of(boundary_matches.begin(), boundary_matches.end(), [&](const auto& m) {
        return m.segment_id == parent_id && m.match_kind == dejamove::PositionMatchKind::End;
    }));
    REQUIRE(std::any_of(boundary_matches.begin(), boundary_matches.end(), [&](const auto& m) {
        return m.segment_id == r2.segment_id &&
               m.match_kind == dejamove::PositionMatchKind::Start && m.next_move_san == "Bc4";
    }));

    // 4. Transposition in a separate line
    const auto qgd1 =
        graph.add_variant("QGD d4", Side::White, init_fen, {{"d4"}, {"d5"}, {"c4"}, {"e6"}});
    const auto qgd2 =
        graph.add_variant("QGD c4", Side::White, init_fen, {{"c4"}, {"e6"}, {"d4"}, {"d5"}});
    REQUIRE(qgd1.ok);
    REQUIRE(qgd2.ok);
    const auto qgd_matches = graph.find_positions_by_fen(
        RepertoireGraph::end_normalized_fen(*graph.find_segment(qgd1.segment_id)));
    REQUIRE(qgd_matches.size() == 2);

    // 5. Unmatched position returns empty
    ChessBoard unplayed;
    REQUIRE(unplayed.make_san_move("a4").has_value());
    REQUIRE(graph.find_positions_by_fen(unplayed.normalized_fen()).empty());
}
