#include "dejamove/rpc_server.hpp"

#include "dejamove/chess_board.hpp"
#include "dejamove/persistence.hpp"

#include <stdexcept>

namespace dejamove {

namespace {

std::string status_to_string(GameStatus status) {
    switch (status) {
    case GameStatus::Ongoing:
        return "ongoing";
    case GameStatus::Check:
        return "check";
    case GameStatus::Checkmate:
        return "checkmate";
    case GameStatus::Stalemate:
        return "stalemate";
    case GameStatus::Draw:
        return "draw";
    }
    return "ongoing";
}

nlohmann::json legal_moves_json(const ChessBoard& board) {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& m : board.legal_moves()) {
        arr.push_back(nlohmann::json{
            {"uci", m.uci},
            {"san", m.san},
            {"from", m.from},
            {"to", m.to},
            {"promotion", m.promotion},
        });
    }
    return arr;
}

nlohmann::json board_state_json(const ChessBoard& board) {
    return nlohmann::json{
        {"fen", board.fen()},
        {"normalizedFen", board.normalized_fen()},
        {"sideToMove", board.side_to_move() == Side::White ? "white" : "black"},
        {"status", status_to_string(board.status())},
        {"legalMoves", legal_moves_json(board)},
    };
}

std::vector<MoveInput> parse_move_inputs(const nlohmann::json& arr) {
    std::vector<MoveInput> inputs;
    if (!arr.is_array()) {
        return inputs;
    }
    inputs.reserve(arr.size());
    for (const auto& item : arr) {
        if (item.is_string()) {
            inputs.push_back(MoveInput{.move = item.get<std::string>(), .description = ""});
        } else if (item.is_object()) {
            inputs.push_back(MoveInput{
                .move = item.value("move", ""),
                .description = item.value("description", ""),
            });
        }
    }
    return inputs;
}

nlohmann::json make_error_response(const nlohmann::json& id, int code, const std::string& msg) {
    return nlohmann::json{
        {"jsonrpc", "2.0"},
        {"id", id},
        {"error", {{"code", code}, {"message", msg}}},
    };
}

} // namespace

RpcServer::RpcServer(std::filesystem::path default_storage_path)
    : storage_path_(std::move(default_storage_path)) {
    if (!storage_path_.empty() && std::filesystem::exists(storage_path_)) {
        std::string err;
        load_repertoire_from_file(storage_path_, repertoire_, err);
    }
}

nlohmann::json RpcServer::handle_request(const nlohmann::json& request) {
    const nlohmann::json id = request.contains("id") ? request["id"] : nlohmann::json(nullptr);
    if (!request.is_object() || !request.contains("method") || !request["method"].is_string()) {
        return make_error_response(id, -32600, "Invalid Request");
    }

    const std::string method = request["method"].get<std::string>();
    const nlohmann::json params =
        request.contains("params") ? request["params"] : nlohmann::json::object();

    try {
        nlohmann::json result = dispatch_method(method, params);
        return nlohmann::json{
            {"jsonrpc", "2.0"},
            {"id", id},
            {"result", std::move(result)},
        };
    } catch (const std::invalid_argument& ex) {
        return make_error_response(id, -32602, ex.what());
    } catch (const std::exception& ex) {
        return make_error_response(id, -32000, ex.what());
    }
}

std::string RpcServer::handle_line(std::string_view line) {
    try {
        const nlohmann::json req = nlohmann::json::parse(line);
        return handle_request(req).dump();
    } catch (const std::exception& ex) {
        return make_error_response(nullptr, -32700, std::string("Parse error: ") + ex.what())
            .dump();
    }
}

nlohmann::json RpcServer::dispatch_method(std::string_view method, const nlohmann::json& params) {
    if (method == "ping") {
        return nlohmann::json{{"ok", true}, {"version", "0.1.0"}};
    }

    if (method == "board.initial" || method == "board.state") {
        const std::string fen = params.value("fen", "");
        std::optional<ChessBoard> board =
            fen.empty() ? std::optional<ChessBoard>(ChessBoard()) : ChessBoard::from_fen(fen);
        if (!board.has_value()) {
            return nlohmann::json{{"valid", false}, {"error", "Invalid FEN"}};
        }
        nlohmann::json out = board_state_json(*board);
        out["valid"] = true;
        return out;
    }

    if (method == "board.applyMove") {
        const std::string fen = params.value("fen", "");
        const std::string move = params.value("move", "");
        std::optional<ChessBoard> board =
            fen.empty() ? std::optional<ChessBoard>(ChessBoard()) : ChessBoard::from_fen(fen);
        if (!board.has_value()) {
            throw std::invalid_argument("Invalid FEN");
        }
        auto res = board->make_uci_move(move);
        if (!res.has_value()) {
            res = board->make_san_move(move);
        }
        if (!res.has_value()) {
            return nlohmann::json{{"valid", false}, {"error", "Illegal move"}};
        }
        nlohmann::json out = board_state_json(*board);
        out["valid"] = true;
        out["uci"] = res->uci;
        out["san"] = res->san;
        return out;
    }

    if (method == "repertoire.list") {
        return serialize_repertoire(repertoire_);
    }

    if (method == "repertoire.addVariant") {
        const std::string name = params.value("name", "");
        const std::string side_str = params.value("side", "white");
        const Side side = (side_str == "black") ? Side::Black : Side::White;
        const std::string start_fen = params.value("startFen", ChessBoard().fen());
        const auto inputs = parse_move_inputs(params.value("moves", nlohmann::json::array()));

        const auto res = repertoire_.add_variant(name, side, start_fen, inputs);
        return nlohmann::json{
            {"ok", res.ok},
            {"error", res.error},
            {"segmentId", res.segment_id},
            {"splitOccurred", res.split_occurred},
            {"splitParentId", res.split_parent_id},
        };
    }

    if (method == "repertoire.branchFrom") {
        const std::string parent_id = params.value("parentId", "");
        const std::size_t after_ply = params.value("afterPly", std::size_t{0});
        const std::string name = params.value("name", "");
        const auto inputs = parse_move_inputs(params.value("moves", nlohmann::json::array()));

        const auto res = repertoire_.branch_from(parent_id, after_ply, name, inputs);
        return nlohmann::json{
            {"ok", res.ok},
            {"error", res.error},
            {"segmentId", res.segment_id},
            {"splitOccurred", res.split_occurred},
            {"splitParentId", res.split_parent_id},
        };
    }

    if (method == "repertoire.linkParentChild") {
        const std::string parent_id = params.value("parentId", "");
        const std::string child_id = params.value("childId", "");
        const auto res = repertoire_.link_parent_child(parent_id, child_id);
        return nlohmann::json{{"ok", res.ok}, {"error", res.error}};
    }

    if (method == "repertoire.renameVariant") {
        const bool ok =
            repertoire_.rename_variant(params.value("id", ""), params.value("name", ""));
        return nlohmann::json{{"ok", ok}};
    }

    if (method == "repertoire.setMoveDescription") {
        const bool ok = repertoire_.set_move_description(params.value("id", ""),
                                                         params.value("plyIndex", std::size_t{0}),
                                                         params.value("description", ""));
        return nlohmann::json{{"ok", ok}};
    }

    if (method == "repertoire.removeVariant") {
        const bool ok = repertoire_.remove_variant(params.value("id", ""));
        return nlohmann::json{{"ok", ok}};
    }

    if (method == "repertoire.continuationsAt") {
        const std::string fen = params.value("fen", "");
        const auto board = ChessBoard::from_fen(fen);
        if (!board.has_value()) {
            throw std::invalid_argument("Invalid FEN");
        }
        nlohmann::json arr = nlohmann::json::array();
        for (const auto& c : repertoire_.continuations_at(board->normalized_fen())) {
            arr.push_back(nlohmann::json{
                {"uci", c.uci},
                {"san", c.san},
                {"segmentId", c.segment_id},
                {"plyIndex", c.ply_index},
                {"description", c.description},
            });
        }
        return nlohmann::json{{"continuations", std::move(arr)}};
    }

    if (method == "repertoire.save") {
        const std::string path_str = params.value("path", storage_path_.string());
        if (path_str.empty()) {
            throw std::invalid_argument("No storage path provided");
        }
        std::string err;
        const bool ok = save_repertoire_to_file(repertoire_, path_str, err);
        return nlohmann::json{{"ok", ok}, {"error", err}};
    }

    if (method == "repertoire.load") {
        const std::string path_str = params.value("path", storage_path_.string());
        if (path_str.empty()) {
            throw std::invalid_argument("No storage path provided");
        }
        std::string err;
        const bool ok = load_repertoire_from_file(path_str, repertoire_, err);
        return nlohmann::json{{"ok", ok}, {"error", err}};
    }

    throw std::runtime_error("Method not found: " + std::string(method));
}

} // namespace dejamove
