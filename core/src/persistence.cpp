#include "dejamove/persistence.hpp"

#include <fstream>

namespace dejamove {

namespace {

std::string side_to_string(Side side) {
    return side == Side::White ? "white" : "black";
}

std::optional<Side> string_to_side(std::string_view s) {
    if (s == "white") {
        return Side::White;
    }
    if (s == "black") {
        return Side::Black;
    }
    return std::nullopt;
}

nlohmann::json serialize_step(const MoveStep& step) {
    return nlohmann::json{
        {"uci", step.uci},
        {"san", step.san},
        {"fen", step.fen},
        {"normalizedFen", step.normalized_fen},
        {"description", step.description},
    };
}

nlohmann::json serialize_stats(const VariantStats& stats) {
    return nlohmann::json{
        {"score", stats.score},
        {"attempts", stats.attempts},
        {"successes", stats.successes},
        {"streak", stats.streak},
        {"lastPracticedMs", stats.last_practiced_ms},
    };
}

} // namespace

nlohmann::json serialize_repertoire(const RepertoireGraph& graph) {
    nlohmann::json segments_json = nlohmann::json::array();
    for (const VariantSegment* seg : graph.all_segments()) {
        nlohmann::json moves_json = nlohmann::json::array();
        for (const auto& step : seg->moves) {
            moves_json.push_back(serialize_step(step));
        }
        segments_json.push_back(nlohmann::json{
            {"id", seg->id},
            {"name", seg->name},
            {"displayName", graph.display_name(seg->id)},
            {"side", side_to_string(seg->side)},
            {"startFen", seg->start_fen},
            {"startNormalizedFen", seg->start_normalized_fen},
            {"moves", std::move(moves_json)},
            {"parentIds", seg->parent_ids},
            {"childIds", seg->child_ids},
            {"tags", seg->tags},
            {"stats", serialize_stats(seg->stats)},
        });
    }

    return nlohmann::json{
        {"schemaVersion", kSchemaVersion},
        {"nextId", graph.next_id_counter()},
        {"segments", std::move(segments_json)},
    };
}

bool deserialize_repertoire(const nlohmann::json& j, RepertoireGraph& out, std::string& error_out) {
    if (!j.is_object() || !j.contains("schemaVersion") || !j.contains("segments")) {
        error_out = "Invalid repertoire JSON structure.";
        return false;
    }
    const int version = j.value("schemaVersion", 0);
    if (version != kSchemaVersion) {
        error_out = "Unsupported schemaVersion: " + std::to_string(version);
        return false;
    }
    if (!j["segments"].is_array()) {
        error_out = "'segments' must be an array.";
        return false;
    }

    RepertoireGraph temp;
    temp.set_next_id_counter(j.value("nextId", std::uint64_t{1}));

    for (const auto& sj : j["segments"]) {
        VariantSegment seg;
        seg.id = sj.value("id", "");
        seg.name = sj.value("name", "");
        auto side_opt = string_to_side(sj.value("side", ""));
        if (seg.id.empty() || !side_opt.has_value()) {
            error_out = "Segment missing valid id or side.";
            return false;
        }
        seg.side = *side_opt;
        seg.start_fen = sj.value("startFen", "");
        seg.start_normalized_fen = sj.value("startNormalizedFen", "");

        if (sj.contains("moves") && sj["moves"].is_array()) {
            for (const auto& mj : sj["moves"]) {
                seg.moves.push_back(MoveStep{
                    .uci = mj.value("uci", ""),
                    .san = mj.value("san", ""),
                    .fen = mj.value("fen", ""),
                    .normalized_fen = mj.value("normalizedFen", ""),
                    .description = mj.value("description", ""),
                });
            }
        }
        if (sj.contains("parentIds") && sj["parentIds"].is_array()) {
            seg.parent_ids = sj["parentIds"].get<std::vector<std::string>>();
        }
        if (sj.contains("childIds") && sj["childIds"].is_array()) {
            seg.child_ids = sj["childIds"].get<std::vector<std::string>>();
        }
        if (sj.contains("tags") && sj["tags"].is_array()) {
            seg.tags = sj["tags"].get<std::vector<std::string>>();
        }
        if (sj.contains("stats") && sj["stats"].is_object()) {
            const auto& st = sj["stats"];
            seg.stats.score = st.value("score", 0.0);
            seg.stats.attempts = st.value("attempts", std::uint32_t{0});
            seg.stats.successes = st.value("successes", std::uint32_t{0});
            seg.stats.streak = st.value("streak", std::uint32_t{0});
            seg.stats.last_practiced_ms = st.value("lastPracticedMs", std::int64_t{0});
        }
        temp.insert_raw_segment(std::move(seg));
    }

    temp.reconcile_links();
    out = std::move(temp);
    return true;
}

bool save_repertoire_to_file(const RepertoireGraph& graph, const std::filesystem::path& path,
                             std::string& error_out) {
    try {
        if (path.has_parent_path()) {
            std::filesystem::create_directories(path.parent_path());
        }
        std::ofstream ofs(path, std::ios::binary | std::ios::trunc);
        if (!ofs) {
            error_out = "Failed to open file for writing: " + path.string();
            return false;
        }
        ofs << serialize_repertoire(graph).dump(2) << '\n';
        return true;
    } catch (const std::exception& ex) {
        error_out = ex.what();
        return false;
    }
}

bool load_repertoire_from_file(const std::filesystem::path& path, RepertoireGraph& out,
                               std::string& error_out) {
    try {
        std::ifstream ifs(path, std::ios::binary);
        if (!ifs) {
            error_out = "Failed to open file for reading: " + path.string();
            return false;
        }
        nlohmann::json j;
        ifs >> j;
        return deserialize_repertoire(j, out, error_out);
    } catch (const std::exception& ex) {
        error_out = ex.what();
        return false;
    }
}

} // namespace dejamove
