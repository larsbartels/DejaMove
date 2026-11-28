#pragma once

#include "dejamove/repertoire_graph.hpp"

#include <cstddef>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>

namespace dejamove {

inline constexpr int kSchemaVersion = 1;

struct MergeResult {
    RepertoireGraph merged;
    std::size_t added_segments = 0;
    std::size_t updated_segments = 0;
};

[[nodiscard]] nlohmann::json serialize_repertoire(const RepertoireGraph& graph);
bool deserialize_repertoire(const nlohmann::json& j, RepertoireGraph& out, std::string& error_out);

[[nodiscard]] MergeResult merge_repertoires(const RepertoireGraph& local,
                                            const RepertoireGraph& remote);

bool save_repertoire_to_file(const RepertoireGraph& graph, const std::filesystem::path& path,
                             std::string& error_out);
bool load_repertoire_from_file(const std::filesystem::path& path, RepertoireGraph& out,
                               std::string& error_out);

} // namespace dejamove
