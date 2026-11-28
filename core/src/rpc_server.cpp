#include "dejamove/rpc_server.hpp"

#include "dejamove/chess_board.hpp"
#include "dejamove/persistence.hpp"

#include <chrono>
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

std::string match_kind_to_string(PositionMatchKind kind) {
    switch (kind) {
    case PositionMatchKind::Start:
        return "start";
    case PositionMatchKind::Interior:
        return "interior";
    case PositionMatchKind::End:
        return "end";
    }
    return "start";
}

std::int64_t current_epoch_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

nlohmann::json expected_moves_json(const std::vector<ExpectedMoveOption>& opts) {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& o : opts) {
        arr.push_back(nlohmann::json{
            {"uci", o.uci},
            {"san", o.san},
            {"description", o.description},
            {"targetSegmentId", o.target_segment_id},
            {"targetPlyIndex", o.target_ply_index},
        });
    }
    return arr;
}

nlohmann::json session_state_json(const TrainingSessionState& s, const RepertoireGraph& graph) {
    nlohmann::json history_arr = nlohmann::json::array();
    for (const auto& h : s.history) {
        history_arr.push_back(nlohmann::json{
            {"uci", h.uci},
            {"san", h.san},
            {"fen", h.fen},
            {"description", h.description},
            {"bySide", h.by_side == Side::White ? "white" : "black"},
            {"isUserMove", h.is_user_move},
            {"wasMistake", h.was_mistake},
        });
    }

    nlohmann::json deltas_arr = nlohmann::json::array();
    for (const auto& d : s.score_deltas) {
        deltas_arr.push_back(nlohmann::json{
            {"segmentId", d.segment_id},
            {"name", d.name},
            {"passed", d.passed},
            {"previousScore", d.previous_score},
            {"newScore", d.new_score},
        });
    }

    const auto* cur_seg = graph.find_segment(s.current_segment_id);
    const auto board = ChessBoard::from_fen(s.current_fen);

    return nlohmann::json{
        {"active", s.active},
        {"completed", s.completed},
        {"awaitingMistakeAdvance", s.awaiting_mistake_advance},
        {"startSegmentId", s.start_segment_id},
        {"currentSegmentId", s.current_segment_id},
        {"currentSegmentName", cur_seg ? cur_seg->name : ""},
        {"userSide", s.user_side == Side::White ? "white" : "black"},
        {"startFen", s.start_fen},
        {"currentFen", s.current_fen},
        {"sideToMove",
         board.has_value() ? (board->side_to_move() == Side::White ? "white" : "black") : "white"},
        {"legalMoves", board.has_value() ? legal_moves_json(*board) : nlohmann::json::array()},
        {"history", std::move(history_arr)},
        {"pendingExpectedMoves", expected_moves_json(s.pending_expected_moves)},
        {"scoreDeltas", std::move(deltas_arr)},
    };
}

} // namespace

void RpcServer::auto_save_if_configured() const {
    if (storage_path_.empty()) {
        return;
    }
    std::string err;
    save_repertoire_to_file(repertoire_, storage_path_, err);
}

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
        if (res.ok) {
            auto_save_if_configured();
        }
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
        if (res.ok) {
            auto_save_if_configured();
        }
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
        if (res.ok) {
            auto_save_if_configured();
        }
        return nlohmann::json{{"ok", res.ok}, {"error", res.error}};
    }

    if (method == "repertoire.renameVariant") {
        const bool ok =
            repertoire_.rename_variant(params.value("id", ""), params.value("name", ""));
        if (ok) {
            auto_save_if_configured();
        }
        return nlohmann::json{{"ok", ok}};
    }

    if (method == "repertoire.setMoveDescription") {
        const bool ok = repertoire_.set_move_description(params.value("id", ""),
                                                         params.value("plyIndex", std::size_t{0}),
                                                         params.value("description", ""));
        if (ok) {
            auto_save_if_configured();
        }
        return nlohmann::json{{"ok", ok}};
    }

    if (method == "repertoire.removeVariant") {
        const bool ok = repertoire_.remove_variant(params.value("id", ""));
        if (ok) {
            auto_save_if_configured();
        }
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
                {"variantName", c.segment_name},
                {"variantNames", c.variant_names},
                {"plyIndex", c.ply_index},
                {"description", c.description},
            });
        }
        return nlohmann::json{{"continuations", std::move(arr)}};
    }

    if (method == "repertoire.findByFen") {
        const std::string fen = params.value("fen", "");
        const std::int64_t now_ms = params.value("nowMs", current_epoch_ms());
        const auto board = ChessBoard::from_fen(fen);
        if (!board.has_value()) {
            return nlohmann::json{
                {"ok", false},
                {"error", "Invalid FEN"},
                {"matches", nlohmann::json::array()},
            };
        }

        nlohmann::json matches_arr = nlohmann::json::array();
        for (const auto& m : repertoire_.find_positions_by_fen(board->normalized_fen())) {
            double eff_score = 0.0;
            if (const auto* seg = repertoire_.find_segment(m.segment_id)) {
                eff_score = training_engine_.effective_score(seg->stats, now_ms);
            }
            matches_arr.push_back(nlohmann::json{
                {"segmentId", m.segment_id},
                {"name", m.segment_name},
                {"side", m.side == Side::White ? "white" : "black"},
                {"plyIndex", m.ply_index},
                {"matchKind", match_kind_to_string(m.match_kind)},
                {"moveSan", m.move_san},
                {"nextMoveSan", m.next_move_san},
                {"effectiveScore", eff_score},
            });
        }
        return nlohmann::json{
            {"ok", true},
            {"fen", board->fen()},
            {"normalizedFen", board->normalized_fen()},
            {"sideToMove", board->side_to_move() == Side::White ? "white" : "black"},
            {"matches", std::move(matches_arr)},
        };
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

    if (method == "training.listWithScores") {
        const std::int64_t now_ms = params.value("nowMs", current_epoch_ms());
        nlohmann::json out = serialize_repertoire(repertoire_);
        for (auto& seg_json : out["segments"]) {
            const std::string id = seg_json.value("id", "");
            if (const auto* seg = repertoire_.find_segment(id)) {
                seg_json["effectiveScore"] = training_engine_.effective_score(seg->stats, now_ms);
            }
        }
        return out;
    }

    if (method == "training.start") {
        const std::int64_t now_ms = params.value("nowMs", current_epoch_ms());
        const std::string mode = params.value("mode", "specific");
        std::string segment_id = params.value("segmentId", "");

        if (mode == "smartRandom" || segment_id.empty()) {
            std::optional<Side> side_filter;
            if (params.contains("side") && params["side"].is_string()) {
                const std::string s = params["side"].get<std::string>();
                if (s == "white") {
                    side_filter = Side::White;
                } else if (s == "black") {
                    side_filter = Side::Black;
                }
            }
            const auto* picked =
                training_engine_.pick_smart_random_segment(repertoire_, now_ms, side_filter, rng_);
            if (!picked) {
                return nlohmann::json{{"ok", false}, {"error", "No trainable variants found."}};
            }
            segment_id = picked->id;
        }

        auto session_opt = training_engine_.start_session(repertoire_, segment_id, rng_);
        if (!session_opt.has_value()) {
            return nlohmann::json{{"ok", false}, {"error", "Failed to start training session."}};
        }
        active_training_ = std::move(*session_opt);
        return nlohmann::json{
            {"ok", true},
            {"session", session_state_json(active_training_, repertoire_)},
        };
    }

    if (method == "training.submitMove") {
        const std::string move = params.value("move", "");
        const std::int64_t elapsed_ms = params.value("elapsedMs", std::int64_t{2000});
        const std::int64_t now_ms = params.value("nowMs", current_epoch_ms());

        const auto res = training_engine_.submit_move(repertoire_, active_training_, move,
                                                      elapsed_ms, now_ms, rng_);
        active_training_ = res.state;
        if (active_training_.completed) {
            auto_save_if_configured();
        }
        return nlohmann::json{
            {"accepted", res.accepted},
            {"correct", res.correct},
            {"error", res.error},
            {"expectedMoves", expected_moves_json(res.expected_moves)},
            {"session", session_state_json(active_training_, repertoire_)},
        };
    }

    if (method == "training.advanceAfterMistake") {
        const std::int64_t now_ms = params.value("nowMs", current_epoch_ms());
        active_training_ =
            training_engine_.advance_after_mistake(repertoire_, active_training_, now_ms, rng_);
        if (active_training_.completed) {
            auto_save_if_configured();
        }
        return nlohmann::json{
            {"session", session_state_json(active_training_, repertoire_)},
        };
    }

    if (method == "training.getState") {
        return nlohmann::json{
            {"session", session_state_json(active_training_, repertoire_)},
        };
    }

    if (method == "engine.status") {
        return nlohmann::json{
            {"available", uci_engine_.is_available()},
            {"enginePath", uci_engine_.engine_path()},
        };
    }

    if (method == "engine.configure") {
        const std::string path = params.value("path", "");
        const int threads = params.value("threads", 1);
        const bool ok = uci_engine_.configure(path, threads);
        return nlohmann::json{
            {"ok", ok},
            {"available", uci_engine_.is_available()},
            {"enginePath", uci_engine_.engine_path()},
        };
    }

    if (method == "engine.analyze") {
        const std::string fen = params.value("fen", "");
        const int multi_pv = params.value("multiPv", 3);
        const int depth = params.value("depth", 14);
        const int move_time_ms = params.value("moveTimeMs", 800);

        const auto res = uci_engine_.analyze(fen, multi_pv, depth, move_time_ms);
        nlohmann::json lines_arr = nlohmann::json::array();
        for (const auto& l : res.lines) {
            lines_arr.push_back(nlohmann::json{
                {"multipv", l.multipv},
                {"depth", l.depth},
                {"isMate", l.eval.is_mate},
                {"centipawns", l.eval.centipawns},
                {"mateIn", l.eval.mate_in},
                {"pvUci", l.pv_uci},
            });
        }
        return nlohmann::json{
            {"ok", res.ok},
            {"error", res.error},
            {"fen", res.fen},
            {"lines", std::move(lines_arr)},
        };
    }

    throw std::runtime_error("Method not found: " + std::string(method));
}

} // namespace dejamove
