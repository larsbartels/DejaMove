#pragma once

#include "dejamove/repertoire_graph.hpp"

#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>

namespace dejamove {

/**
 * @brief JSON-RPC 2.0 dispatcher over line-delimited JSON messages.
 */
class RpcServer {
  public:
    explicit RpcServer(std::filesystem::path default_storage_path = {});

    [[nodiscard]] nlohmann::json handle_request(const nlohmann::json& request);
    [[nodiscard]] std::string handle_line(std::string_view line);

    [[nodiscard]] const RepertoireGraph& repertoire() const {
        return repertoire_;
    }

  private:
    nlohmann::json dispatch_method(std::string_view method, const nlohmann::json& params);

    RepertoireGraph repertoire_;
    std::filesystem::path storage_path_;
};

} // namespace dejamove
