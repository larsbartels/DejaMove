#pragma once

#include "dejamove/repertoire_graph.hpp"

#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>

namespace dejamove {

inline constexpr int kSchemaVersion = 1;

[[nodiscard]] nlohmann::json serialize_repertoire(const RepertoireGraph& graph);
bool deserialize_repertoire(const nlohmann::json& j, RepertoireGraph& out, std::string& error_out);

bool save_repertoire_to_file(const RepertoireGraph& graph, const std::filesystem::path& path,
                             std::string& error_out);
bool load_repertoire_from_file(const std::filesystem::path& path, RepertoireGraph& out,
                               std::string& error_out);

} // namespace dejamove
