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
