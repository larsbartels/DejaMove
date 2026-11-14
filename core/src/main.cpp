#include "dejamove/rpc_server.hpp"

#include <iostream>
#include <string>

int main(int argc, char* argv[]) {
    std::filesystem::path storage_path;
    if (argc >= 2) {
        storage_path = argv[1];
    }

    dejamove::RpcServer server(std::move(storage_path));

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) {
            continue;
        }
        std::cout << server.handle_line(line) << '\n' << std::flush;
    }
    return 0;
}
