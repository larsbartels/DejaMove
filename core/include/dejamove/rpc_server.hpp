#pragma once

#include "dejamove/repertoire_graph.hpp"
#include "dejamove/training_engine.hpp"
#include "dejamove/uci_engine.hpp"

#include <filesystem>
#include <nlohmann/json.hpp>
#include <random>
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
    void auto_save_if_configured() const;

    RepertoireGraph repertoire_;
    TrainingEngine training_engine_;
    TrainingSessionState active_training_;
    UciEngine uci_engine_;
    std::mt19937_64 rng_{std::random_device{}()};
    std::filesystem::path storage_path_;
};

} // namespace dejamove
