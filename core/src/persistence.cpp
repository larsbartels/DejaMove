#include "dejamove/persistence.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <system_error>
#include <unordered_map>

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

std::string segment_signature(const VariantSegment& seg) {
    std::string sig = side_to_string(seg.side);
    sig += '|';
    sig += seg.start_normalized_fen;
    sig += '|';
    for (std::size_t i = 0; i < seg.moves.size(); ++i) {
        if (i > 0) {
            sig += ',';
        }
        sig += seg.moves[i].uci;
    }
    return sig;
}

std::uint64_t parse_numeric_id(std::string_view id) {
    if (id.size() < 2 || id[0] != 'v') {
        return 0;
    }
    std::uint64_t val = 0;
    for (std::size_t i = 1; i < id.size(); ++i) {
        const char ch = id[i];
        if (!std::isdigit(static_cast<unsigned char>(ch))) {
            return 0;
        }
        val = val * 10 + static_cast<std::uint64_t>(ch - '0');
    }
    return val;
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
            {"side", side_to_string(seg->side)},
            {"startFen", seg->start_fen},
            {"startNormalizedFen", seg->start_normalized_fen},
            {"moves", std::move(moves_json)},
            {"parentIds", seg->parent_ids},
            {"childIds", seg->child_ids},
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

    out = std::move(temp);
    return true;
}

MergeResult merge_repertoires(const RepertoireGraph& local, const RepertoireGraph& remote) {
    MergeResult result;
    std::unordered_map<std::string, VariantSegment> merged_map;
    std::unordered_map<std::string, std::string> sig_to_id;
    std::uint64_t next_counter = std::max(local.next_id_counter(), remote.next_id_counter());

    for (const VariantSegment* seg : local.all_segments()) {
        merged_map.emplace(seg->id, *seg);
        sig_to_id.emplace(segment_signature(*seg), seg->id);
        next_counter = std::max(next_counter, parse_numeric_id(seg->id) + 1);
    }

    std::unordered_map<std::string, std::string> remote_to_merged_id;
    for (const VariantSegment* r_seg : remote.all_segments()) {
        next_counter = std::max(next_counter, parse_numeric_id(r_seg->id) + 1);
    }

    for (const VariantSegment* r_seg : remote.all_segments()) {
        const std::string sig = segment_signature(*r_seg);
        const auto existing_it = sig_to_id.find(sig);
        if (existing_it != sig_to_id.end()) {
            auto& local_seg = merged_map.at(existing_it->second);
            remote_to_merged_id.emplace(r_seg->id, local_seg.id);

            bool changed = false;
            if (r_seg->stats.last_practiced_ms > local_seg.stats.last_practiced_ms ||
                (r_seg->stats.last_practiced_ms == local_seg.stats.last_practiced_ms &&
                 r_seg->stats.attempts > local_seg.stats.attempts)) {
                local_seg.stats = r_seg->stats;
                changed = true;
            }
            if (local_seg.name.empty() && !r_seg->name.empty()) {
                local_seg.name = r_seg->name;
                changed = true;
            }
            const std::size_t move_count = std::min(local_seg.moves.size(), r_seg->moves.size());
            for (std::size_t i = 0; i < move_count; ++i) {
                if (local_seg.moves[i].description.empty() &&
                    !r_seg->moves[i].description.empty()) {
                    local_seg.moves[i].description = r_seg->moves[i].description;
                    changed = true;
                }
            }
            if (changed) {
                ++result.updated_segments;
            }
            continue;
        }

        std::string new_id = r_seg->id;
        if (new_id.empty() || merged_map.contains(new_id)) {
            do {
                new_id = "v" + std::to_string(next_counter++);
            } while (merged_map.contains(new_id));
        }

        VariantSegment copy = *r_seg;
        copy.id = new_id;
        copy.parent_ids.clear();
        copy.child_ids.clear();

        remote_to_merged_id.emplace(r_seg->id, new_id);
        sig_to_id.emplace(sig, new_id);
        merged_map.emplace(new_id, std::move(copy));
        ++result.added_segments;
    }

    result.merged.set_next_id_counter(next_counter);
    std::vector<std::string> sorted_ids;
    sorted_ids.reserve(merged_map.size());
    for (const auto& [id, _] : merged_map) {
        sorted_ids.push_back(id);
    }
    std::sort(sorted_ids.begin(), sorted_ids.end());
    for (const auto& id : sorted_ids) {
        result.merged.insert_raw_segment(std::move(merged_map.at(id)));
    }

    for (const VariantSegment* r_seg : remote.all_segments()) {
        const auto p_it = remote_to_merged_id.find(r_seg->id);
        if (p_it == remote_to_merged_id.end()) {
            continue;
        }
        for (const auto& r_child_id : r_seg->child_ids) {
            const auto c_it = remote_to_merged_id.find(r_child_id);
            if (c_it != remote_to_merged_id.end()) {
                (void)result.merged.link_parent_child(p_it->second, c_it->second);
            }
        }
    }

    return result;
}

bool save_repertoire_to_file(const RepertoireGraph& graph, const std::filesystem::path& path,
                             std::string& error_out) {
    try {
        if (path.has_parent_path()) {
            std::filesystem::create_directories(path.parent_path());
        }
        std::filesystem::path tmp_path = path;
        tmp_path += ".tmp";

        {
            std::ofstream ofs(tmp_path, std::ios::binary | std::ios::trunc);
            if (!ofs) {
                error_out = "Failed to open temporary file for writing: " + tmp_path.string();
                return false;
            }
            ofs << serialize_repertoire(graph).dump(2) << '\n';
            ofs.flush();
            if (!ofs) {
                error_out = "Failed to write temporary file: " + tmp_path.string();
                return false;
            }
        }

        std::error_code ec;
        std::filesystem::rename(tmp_path, path, ec);
        if (ec) {
            std::error_code rm_ec;
            std::filesystem::remove(tmp_path, rm_ec);
            error_out = "Failed to replace repertoire file: " + ec.message();
            return false;
        }
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
