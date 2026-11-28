#include "dejamove/persistence.hpp"
#include "dejamove/rpc_server.hpp"

#include <catch2/catch_test_macros.hpp>
#include <filesystem>

using dejamove::ChessBoard;
using dejamove::RepertoireGraph;
using dejamove::RpcServer;
using dejamove::Side;

TEST_CASE("Persistence round-trips a multi-parent DAG with descriptions and stats",
          "[persistence]") {
    RepertoireGraph original;
    const std::string init_fen = ChessBoard().fen();

    const auto p1 =
        original.add_variant("Via d4", Side::White, init_fen, {{"d4"}, {"d5"}, {"c4"}, {"e6"}});
    const auto p2 =
        original.add_variant("Via c4", Side::White, init_fen, {{"c4"}, {"e6"}, {"d4"}, {"d5"}});
    REQUIRE(p1.ok);
    REQUIRE(p2.ok);

    const std::string shared_fen = RepertoireGraph::end_fen(*original.find_segment(p1.segment_id));
    const auto child =
        original.add_variant("Shared Child", Side::White, shared_fen, {{"Nc3", "Develop knight"}});
    REQUIRE(child.ok);
    REQUIRE(original.link_parent_child(p1.segment_id, child.segment_id).ok);
    REQUIRE(original.link_parent_child(p2.segment_id, child.segment_id).ok);

    const auto tmp_path = std::filesystem::temp_directory_path() / "dejamove_persistence_test.json";
    std::string err;
    REQUIRE(dejamove::save_repertoire_to_file(original, tmp_path, err));

    RepertoireGraph loaded;
    REQUIRE(dejamove::load_repertoire_from_file(tmp_path, loaded, err));
    std::filesystem::remove(tmp_path);

    REQUIRE(loaded.size() == 3);
    const auto* loaded_child = loaded.find_segment(child.segment_id);
    REQUIRE(loaded_child != nullptr);
    REQUIRE(loaded_child->parent_ids.size() == 2);
    REQUIRE(loaded_child->moves[0].description == "Develop knight");
}

TEST_CASE("RpcServer handles board moves and repertoire splitting over JSON-RPC", "[rpc]") {
    RpcServer server;

    const auto ping =
        nlohmann::json::parse(server.handle_line(R"({"jsonrpc":"2.0","id":1,"method":"ping"})"));
    REQUIRE(ping["result"]["ok"] == true);

    const auto mv = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":2,"method":"board.applyMove","params":{"move":"e2e4"}})"));
    REQUIRE(mv["result"]["valid"] == true);
    REQUIRE(mv["result"]["san"] == "e4");

    const auto add1 = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":3,"method":"repertoire.addVariant","params":{"name":"Italian","side":"white","moves":["e4","e5","Nf3","Nc6"]}})"));
    REQUIRE(add1["result"]["ok"] == true);

    const auto add2 = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":4,"method":"repertoire.addVariant","params":{"name":"Bishop","side":"white","moves":["e4","e5","Bc4","Nf6"]}})"));
    REQUIRE(add2["result"]["ok"] == true);
    REQUIRE(add2["result"]["splitOccurred"] == true);

    const auto list = nlohmann::json::parse(
        server.handle_line(R"({"jsonrpc":"2.0","id":5,"method":"repertoire.list"})"));
    REQUIRE(list["result"]["segments"].size() == 3);
}

TEST_CASE("RpcServer drives training sessions including mistake recovery", "[rpc]") {
    RpcServer server;

    REQUIRE(
        nlohmann::json::parse(server.handle_line(
            R"({"jsonrpc":"2.0","id":1,"method":"repertoire.addVariant","params":{"name":"Italian","side":"white","moves":["e4","e5","Nf3","Nc6"]}})"))
            ["result"]["ok"] == true);

    const auto started = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":2,"method":"training.start","params":{"mode":"smartRandom"}})"));
    REQUIRE(started["result"]["ok"] == true);
    REQUIRE(started["result"]["session"]["active"] == true);

    // Wrong move -> returns expectedMoves, awaits advance
    const auto wrong = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":3,"method":"training.submitMove","params":{"move":"d2d4","elapsedMs":1000}})"));
    REQUIRE(wrong["result"]["accepted"] == true);
    REQUIRE(wrong["result"]["correct"] == false);
    REQUIRE(wrong["result"]["expectedMoves"][0]["san"] == "e4");

    const auto adv = nlohmann::json::parse(
        server.handle_line(R"({"jsonrpc":"2.0","id":4,"method":"training.advanceAfterMistake"})"));
    REQUIRE(adv["result"]["session"]["awaitingMistakeAdvance"] == false);

    // Finish line with Nf3
    const auto finish = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":5,"method":"training.submitMove","params":{"move":"Nf3","elapsedMs":1000}})"));
    REQUIRE(finish["result"]["accepted"] == true);
    REQUIRE(finish["result"]["correct"] == true);
    REQUIRE(finish["result"]["session"]["completed"] == true);

    const auto scores = nlohmann::json::parse(
        server.handle_line(R"({"jsonrpc":"2.0","id":6,"method":"training.listWithScores"})"));
    REQUIRE(scores["result"]["segments"].size() == 1);
    REQUIRE(scores["result"]["segments"][0]["stats"]["attempts"] == 1);
}

TEST_CASE("RpcServer repertoire.findByFen locates variants and handles unmatched/invalid FENs",
          "[rpc]") {
    RpcServer server;

    REQUIRE(
        nlohmann::json::parse(server.handle_line(
            R"({"jsonrpc":"2.0","id":1,"method":"repertoire.addVariant","params":{"name":"Ruy Lopez","side":"white","moves":["e4","e5","Nf3","Nc6","Bb5"]}})"))
            ["result"]["ok"] == true);

    // Query with 4-field FEN (no move clocks) after 1. e4 e5 2. Nf3 Nc6
    const auto hit = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":2,"method":"repertoire.findByFen","params":{"fen":"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -"}})"));
    REQUIRE(hit["result"]["ok"] == true);
    REQUIRE(hit["result"]["matches"].size() == 1);
    REQUIRE(hit["result"]["matches"][0]["name"] == "Ruy Lopez");
    REQUIRE(hit["result"]["matches"][0]["plyIndex"] == 4);
    REQUIRE(hit["result"]["matches"][0]["matchKind"] == "interior");
    REQUIRE(hit["result"]["matches"][0]["moveSan"] == "Nc6");
    REQUIRE(hit["result"]["matches"][0]["nextMoveSan"] == "Bb5");
    REQUIRE(hit["result"]["matches"][0].contains("effectiveScore"));

    // Valid FEN not present in repertoire -> ok: true, empty matches
    const auto miss = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":3,"method":"repertoire.findByFen","params":{"fen":"rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1"}})"));
    REQUIRE(miss["result"]["ok"] == true);
    REQUIRE(miss["result"]["matches"].empty());

    // Invalid FEN -> ok: false
    const auto bad = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":4,"method":"repertoire.findByFen","params":{"fen":"not a fen"}})"));
    REQUIRE(bad["result"]["ok"] == false);
    REQUIRE(bad["result"]["matches"].empty());

    // continuationsAt includes variantName and variantNames
    const auto conts = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":5,"method":"repertoire.continuationsAt","params":{"fen":"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"}})"));
    REQUIRE(conts["result"]["continuations"].size() == 1);
    REQUIRE(conts["result"]["continuations"][0]["san"] == "Bb5");
    REQUIRE(conts["result"]["continuations"][0]["variantName"] == "Ruy Lopez");
    REQUIRE(conts["result"]["continuations"][0]["variantNames"] ==
            nlohmann::json::array({"Ruy Lopez"}));
}

TEST_CASE("Atomic save overwrites cleanly without leaving temporary artifacts", "[persistence]") {
    RepertoireGraph graph;
    const std::string init_fen = ChessBoard().fen();
    REQUIRE(graph.add_variant("Line 1", Side::White, init_fen, {{"e4"}, {"e5"}}).ok);

    const auto target_path =
        std::filesystem::temp_directory_path() / "dejamove_atomic_save_test.json";
    auto tmp_path = target_path;
    tmp_path += ".tmp";
    std::filesystem::remove(target_path);
    std::filesystem::remove(tmp_path);

    std::string err;
    REQUIRE(dejamove::save_repertoire_to_file(graph, target_path, err));
    REQUIRE(std::filesystem::exists(target_path));
    REQUIRE_FALSE(std::filesystem::exists(tmp_path));

    // Modify and overwrite existing file atomically
    REQUIRE(graph.add_variant("Line 2", Side::Black, init_fen, {{"d4"}, {"d5"}}).ok);
    REQUIRE(dejamove::save_repertoire_to_file(graph, target_path, err));
    REQUIRE_FALSE(std::filesystem::exists(tmp_path));

    RepertoireGraph reloaded;
    REQUIRE(dejamove::load_repertoire_from_file(target_path, reloaded, err));
    REQUIRE(reloaded.size() == 2);

    std::filesystem::remove(target_path);
}

TEST_CASE(
    "merge_repertoires combines variants, remaps colliding IDs and links, and keeps newest stats",
    "[persistence]") {
    const std::string init_fen = ChessBoard().fen();

    RepertoireGraph local;
    const auto l_italian =
        local.add_variant("Italian", Side::White, init_fen, {{"e4"}, {"e5"}, {"Nf3"}, {"Nc6"}});
    REQUIRE(l_italian.ok);
    // Older local stats on Italian (v1)
    auto* l_seg = local.find_segment_mut(l_italian.segment_id);
    l_seg->stats.score = 40.0;
    l_seg->stats.attempts = 1;
    l_seg->stats.last_practiced_ms = 1000;

    // Colliding v2 locally: French
    const auto l_french = local.add_variant("French", Side::Black, init_fen, {{"e4"}, {"e6"}});
    REQUIRE(l_french.ok);

    RepertoireGraph remote;
    // Remote v1 matches Italian with newer stats & move description
    const auto r_italian = remote.add_variant("Italian", Side::White, init_fen,
                                              {{"e4", "King's pawn"}, {"e5"}, {"Nf3"}, {"Nc6"}});
    REQUIRE(r_italian.ok);
    auto* r_seg = remote.find_segment_mut(r_italian.segment_id);
    r_seg->stats.score = 88.0;
    r_seg->stats.attempts = 4;
    r_seg->stats.last_practiced_ms = 5000;

    // Colliding v2 remotely: QGD -> child QGD Mainline (v3)
    const auto r_qgd =
        remote.add_variant("QGD", Side::White, init_fen, {{"d4"}, {"d5"}, {"c4"}, {"e6"}});
    REQUIRE(r_qgd.ok);
    const std::string qgd_fen = RepertoireGraph::end_fen(*remote.find_segment(r_qgd.segment_id));
    const auto r_qgd_child =
        remote.add_variant("QGD Mainline", Side::White, qgd_fen, {{"Nc3"}, {"Nf6"}});
    REQUIRE(r_qgd_child.ok);
    REQUIRE(remote.link_parent_child(r_qgd.segment_id, r_qgd_child.segment_id).ok);

    const auto merged = dejamove::merge_repertoires(local, remote);
    REQUIRE(merged.added_segments == 2);
    REQUIRE(merged.updated_segments == 1);
    REQUIRE(merged.merged.size() == 4);

    // Local segments preserve IDs; Italian receives newer remote stats and description
    const auto* merged_italian = merged.merged.find_segment(l_italian.segment_id);
    REQUIRE(merged_italian != nullptr);
    REQUIRE(merged_italian->stats.score == 88.0);
    REQUIRE(merged_italian->stats.last_practiced_ms == 5000);
    REQUIRE(merged_italian->moves[0].description == "King's pawn");

    // Local French v2 stays intact
    const auto* merged_french = merged.merged.find_segment(l_french.segment_id);
    REQUIRE(merged_french != nullptr);
    REQUIRE(merged_french->name == "French");

    // Remote QGD gets remapped to a non-colliding ID while preserving its child link
    const dejamove::VariantSegment* merged_qgd = nullptr;
    const dejamove::VariantSegment* merged_qgd_child = nullptr;
    for (const auto* s : merged.merged.all_segments()) {
        if (s->name == "QGD")
            merged_qgd = s;
        if (s->name == "QGD Mainline")
            merged_qgd_child = s;
    }
    REQUIRE(merged_qgd != nullptr);
    REQUIRE(merged_qgd_child != nullptr);
    REQUIRE(merged_qgd->id != l_french.segment_id);
    REQUIRE(merged_qgd->child_ids == std::vector<std::string>{merged_qgd_child->id});
    REQUIRE(merged_qgd_child->parent_ids == std::vector<std::string>{merged_qgd->id});
}

TEST_CASE("RpcServer supports exportJson, mergeJson, and importJson", "[rpc]") {
    RpcServer remote_srv;
    REQUIRE(
        nlohmann::json::parse(remote_srv.handle_line(
            R"({"jsonrpc":"2.0","id":1,"method":"repertoire.addVariant","params":{"name":"Caro-Kann","side":"black","moves":["e4","c6"]}})"))
            ["result"]["ok"] == true);
    const auto exported = nlohmann::json::parse(
        remote_srv.handle_line(R"({"jsonrpc":"2.0","id":2,"method":"repertoire.exportJson"})"));
    REQUIRE(exported["result"]["ok"] == true);
    const nlohmann::json remote_payload = exported["result"]["repertoire"];

    RpcServer local_srv;
    REQUIRE(
        nlohmann::json::parse(local_srv.handle_line(
            R"({"jsonrpc":"2.0","id":1,"method":"repertoire.addVariant","params":{"name":"Sicilian","side":"black","moves":["e4","c5"]}})"))
            ["result"]["ok"] == true);

    const auto merge_res = nlohmann::json::parse(local_srv.handle_line(nlohmann::json{
        {"jsonrpc", "2.0"},
        {"id", 2},
        {"method", "repertoire.mergeJson"},
        {"params", {{"repertoire", remote_payload}}}}.dump()));
    REQUIRE(merge_res["result"]["ok"] == true);
    REQUIRE(merge_res["result"]["added"] == 1);

    const auto list_after_merge = nlohmann::json::parse(
        local_srv.handle_line(R"({"jsonrpc":"2.0","id":3,"method":"repertoire.list"})"));
    REQUIRE(list_after_merge["result"]["segments"].size() == 2);

    // Invalid import payload fails cleanly without overwriting existing repertoire
    const auto bad_import = nlohmann::json::parse(local_srv.handle_line(
        R"({"jsonrpc":"2.0","id":4,"method":"repertoire.importJson","params":{"repertoire":{"schemaVersion":99,"segments":[]}}})"));
    REQUIRE(bad_import["result"]["ok"] == false);
    REQUIRE(nlohmann::json::parse(local_srv.handle_line(
                R"({"jsonrpc":"2.0","id":5,"method":"repertoire.list"})"))["result"]["segments"]
                .size() == 2);

    // Valid importJson replaces current repertoire completely (snapshot restore)
    const auto good_import = nlohmann::json::parse(local_srv.handle_line(nlohmann::json{
        {"jsonrpc", "2.0"},
        {"id", 6},
        {"method", "repertoire.importJson"},
        {"params", {{"repertoire", remote_payload}}}}.dump()));
    REQUIRE(good_import["result"]["ok"] == true);
    const auto list_after_import = nlohmann::json::parse(
        local_srv.handle_line(R"({"jsonrpc":"2.0","id":7,"method":"repertoire.list"})"));
    REQUIRE(list_after_import["result"]["segments"].size() == 1);
    REQUIRE(list_after_import["result"]["segments"][0]["name"] == "Caro-Kann");
}
