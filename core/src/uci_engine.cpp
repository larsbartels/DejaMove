#include "dejamove/uci_engine.hpp"

#include <algorithm>
#include <filesystem>
#include <map>
#include <sstream>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace dejamove {

std::optional<UciLine> parse_uci_info_line(std::string_view line, Side side_to_move) {
    std::istringstream iss{std::string(line)};
    std::string tok;
    if (!(iss >> tok) || tok != "info") {
        return std::nullopt;
    }

    UciLine parsed;
    bool has_score = false;
    bool has_pv = false;

    while (iss >> tok) {
        if (tok == "depth") {
            iss >> parsed.depth;
        } else if (tok == "multipv") {
            iss >> parsed.multipv;
        } else if (tok == "score") {
            std::string kind;
            int val = 0;
            if (iss >> kind >> val) {
                const int sign = (side_to_move == Side::Black) ? -1 : 1;
                if (kind == "cp") {
                    parsed.eval.is_mate = false;
                    parsed.eval.centipawns = val * sign;
                    has_score = true;
                } else if (kind == "mate") {
                    parsed.eval.is_mate = true;
                    parsed.eval.mate_in = val * sign;
                    has_score = true;
                }
            }
        } else if (tok == "pv") {
            std::string move;
            while (iss >> move) {
                parsed.pv_uci.push_back(std::move(move));
            }
            has_pv = !parsed.pv_uci.empty();
            break;
        }
    }

    if (!has_score || !has_pv) {
        return std::nullopt;
    }
    return parsed;
}

bool UciEngine::configure(std::string engine_path, int threads) {
    threads_ = std::max(1, threads);
    if (engine_path.empty() || !std::filesystem::exists(engine_path)) {
        engine_path_.clear();
        return false;
    }
    engine_path_ = std::move(engine_path);
    return true;
}

bool UciEngine::is_available() const {
    return !engine_path_.empty() && std::filesystem::exists(engine_path_);
}

AnalysisResult UciEngine::analyze(std::string_view fen, int multi_pv, int depth,
                                  int move_time_ms) const {
    AnalysisResult result;
    result.fen = std::string(fen);

    if (!is_available()) {
        result.error = "Native Stockfish binary not configured.";
        return result;
    }

    const auto board = ChessBoard::from_fen(fen);
    if (!board.has_value()) {
        result.error = "Invalid FEN.";
        return result;
    }

    const int clamped_pv = std::clamp(multi_pv, 1, 5);
    const int clamped_depth = std::clamp(depth, 1, 30);
    const int clamped_time = std::clamp(move_time_ms, 50, 15000);
    const Side side_to_move = board->side_to_move();

#ifdef _WIN32
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.bInheritHandle = TRUE;

    HANDLE child_stdout_rd = nullptr;
    HANDLE child_stdout_wr = nullptr;
    HANDLE child_stdin_rd = nullptr;
    HANDLE child_stdin_wr = nullptr;

    if (!CreatePipe(&child_stdout_rd, &child_stdout_wr, &sa, 0) ||
        !SetHandleInformation(child_stdout_rd, HANDLE_FLAG_INHERIT, 0) ||
        !CreatePipe(&child_stdin_rd, &child_stdin_wr, &sa, 0) ||
        !SetHandleInformation(child_stdin_wr, HANDLE_FLAG_INHERIT, 0)) {
        result.error = "Failed to create UCI pipes.";
        return result;
    }

    STARTUPINFOA si{};
    si.cb = sizeof(STARTUPINFOA);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = child_stdin_rd;
    si.hStdOutput = child_stdout_wr;
    si.hStdError = child_stdout_wr;

    PROCESS_INFORMATION pi{};
    std::string cmd = "\"" + engine_path_ + "\"";
    if (!CreateProcessA(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                        nullptr, &si, &pi)) {
        CloseHandle(child_stdout_rd);
        CloseHandle(child_stdout_wr);
        CloseHandle(child_stdin_rd);
        CloseHandle(child_stdin_wr);
        result.error = "Failed to launch UCI engine process.";
        return result;
    }

    CloseHandle(child_stdout_wr);
    CloseHandle(child_stdin_rd);

    const std::string script = "uci\n"
                               "setoption name Threads value " +
                               std::to_string(threads_) +
                               "\n"
                               "setoption name MultiPV value " +
                               std::to_string(clamped_pv) +
                               "\n"
                               "isready\n"
                               "position fen " +
                               std::string(fen) +
                               "\n"
                               "go depth " +
                               std::to_string(clamped_depth) + " movetime " +
                               std::to_string(clamped_time) + "\n";

    DWORD written = 0;
    WriteFile(child_stdin_wr, script.data(), static_cast<DWORD>(script.size()), &written, nullptr);

    std::map<int, UciLine> best_by_pv;
    std::string buffer;
    char chunk[4096];
    DWORD read_bytes = 0;
    bool done = false;

    while (!done && ReadFile(child_stdout_rd, chunk, sizeof(chunk), &read_bytes, nullptr) &&
           read_bytes > 0) {
        buffer.append(chunk, read_bytes);
        std::size_t pos = 0;
        while ((pos = buffer.find('\n')) != std::string::npos) {
            std::string line = buffer.substr(0, pos);
            if (!line.empty() && line.back() == '\r') {
                line.pop_back();
            }
            buffer.erase(0, pos + 1);

            if (line.rfind("info ", 0) == 0) {
                if (auto parsed = parse_uci_info_line(line, side_to_move)) {
                    auto it = best_by_pv.find(parsed->multipv);
                    if (it == best_by_pv.end() || parsed->depth >= it->second.depth) {
                        best_by_pv[parsed->multipv] = std::move(*parsed);
                    }
                }
            } else if (line.rfind("bestmove ", 0) == 0) {
                done = true;
                break;
            }
        }
    }

    const std::string quit_cmd = "quit\n";
    WriteFile(child_stdin_wr, quit_cmd.data(), static_cast<DWORD>(quit_cmd.size()), &written,
              nullptr);
    CloseHandle(child_stdin_wr);
    CloseHandle(child_stdout_rd);
    WaitForSingleObject(pi.hProcess, 1000);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    for (auto& [_, line] : best_by_pv) {
        result.lines.push_back(std::move(line));
    }
    result.ok = true;
    return result;
#else
    (void)clamped_pv;
    (void)clamped_depth;
    (void)clamped_time;
    (void)side_to_move;
    result.error = "Native UCI process execution not implemented on this platform.";
    return result;
#endif
}

} // namespace dejamove
