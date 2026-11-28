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

TEST_CASE("Persistence preserves variant tags and reconciles links automatically on load",
          "[persistence]") {
    RepertoireGraph original;
    const std::string init_fen = ChessBoard().fen();

    const auto root =
        original.add_variant("Open", Side::White, init_fen, {{"e4"}, {"e5"}}, {"Mainline", "e4"});
    REQUIRE(root.ok);

    ChessBoard after_e4_e5;
    REQUIRE(after_e4_e5.make_san_move("e4").has_value());
    REQUIRE(after_e4_e5.make_san_move("e5").has_value());
    const auto child = original.add_variant("Ruy", Side::White, after_e4_e5.fen(),
                                            {{"Nf3"}, {"Nc6"}, {"Bb5"}}, {"Spanish"});
    REQUIRE(child.ok);

    nlohmann::json serialized = dejamove::serialize_repertoire(original);
    // Simulate file saved with stale empty parent/child link arrays; loading must auto-reconcile
    for (auto& sj : serialized["segments"]) {
        sj["parentIds"] = nlohmann::json::array();
        sj["childIds"] = nlohmann::json::array();
    }

    RepertoireGraph loaded;
    std::string err;
    REQUIRE(dejamove::deserialize_repertoire(serialized, loaded, err));
    REQUIRE(loaded.find_segment(root.segment_id)->tags ==
            std::vector<std::string>{"Mainline", "e4"});
    REQUIRE(loaded.find_segment(root.segment_id)->child_ids ==
            std::vector<std::string>{child.segment_id});
    REQUIRE(loaded.find_segment(child.segment_id)->parent_ids ==
            std::vector<std::string>{root.segment_id});
}

TEST_CASE("RpcServer supports extendVariant, truncateVariant, setTags, and findByTag", "[rpc]") {
    RpcServer server;

    const auto add_res = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":1,"method":"repertoire.addVariant","params":{"name":"Sicilian","side":"black","moves":["e4","c5"],"tags":["Aggressive","e4-defense"]}})"));
    REQUIRE(add_res["result"]["ok"] == true);
    const std::string seg_id = add_res["result"]["segmentId"];

    const auto ext_res = nlohmann::json::parse(server.handle_line(nlohmann::json{
        {"jsonrpc", "2.0"},
        {"id", 2},
        {"method", "repertoire.extendVariant"},
        {"params", {{"id", seg_id}, {"moves", {"Nf3", "d6"}}}}}.dump()));
    REQUIRE(ext_res["result"]["ok"] == true);

    const auto trunc_res = nlohmann::json::parse(server.handle_line(nlohmann::json{
        {"jsonrpc", "2.0"},
        {"id", 3},
        {"method", "repertoire.truncateVariant"},
        {"params", {{"id", seg_id}, {"keepPlies", 3}}}}.dump()));
    REQUIRE(trunc_res["result"]["ok"] == true);

    const auto list_after_trunc = nlohmann::json::parse(
        server.handle_line(R"({"jsonrpc":"2.0","id":4,"method":"repertoire.list"})"));
    REQUIRE(list_after_trunc["result"]["segments"][0]["moves"].size() == 3);

    const auto tag_res = nlohmann::json::parse(server.handle_line(nlohmann::json{
        {"jsonrpc", "2.0"},
        {"id", 5},
        {"method", "repertoire.setTags"},
        {"params", {{"id", seg_id}, {"tags", {"Najdorf", "Theory"}}}}}.dump()));
    REQUIRE(tag_res["result"]["ok"] == true);

    const auto find_res = nlohmann::json::parse(server.handle_line(
        R"({"jsonrpc":"2.0","id":6,"method":"repertoire.findByTag","params":{"tag":"naj"}})"));
    REQUIRE(find_res["result"]["ok"] == true);
    REQUIRE(find_res["result"]["segmentIds"] == nlohmann::json::array({seg_id}));

    // Unnamed branch gets dynamic "[Parent] - Variant [number]" displayName over RPC
    const auto unnamed_branch = nlohmann::json::parse(server.handle_line(nlohmann::json{
        {"jsonrpc", "2.0"},
        {"id", 7},
        {"method", "repertoire.branchFrom"},
        {"params", {{"parentId", seg_id}, {"afterPly", 1}, {"name", ""}, {"moves", {"Nc3"}}}}}
                                                                             .dump()));
    REQUIRE(unnamed_branch["result"]["ok"] == true);
    const std::string branch_id = unnamed_branch["result"]["segmentId"];

    const auto list_res = nlohmann::json::parse(
        server.handle_line(R"({"jsonrpc":"2.0","id":8,"method":"repertoire.list"})"));
    bool found_unnamed = false;
    for (const auto& s : list_res["result"]["segments"]) {
        if (s["id"] == branch_id) {
            found_unnamed = true;
            REQUIRE(s["name"] == "");
            REQUIRE(s["displayName"] == "Sicilian - Variant 1");
        }
    }
    REQUIRE(found_unnamed);
}
