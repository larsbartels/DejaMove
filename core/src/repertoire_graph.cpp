#include "dejamove/repertoire_graph.hpp"

#include <algorithm>
#include <queue>
#include <unordered_set>

namespace dejamove {

namespace {

std::optional<std::vector<MoveStep>> build_move_steps(std::string_view start_fen,
                                                      const std::vector<MoveInput>& inputs,
                                                      std::string& error_out) {
    if (inputs.empty()) {
        error_out = "Variant must contain at least one move.";
        return std::nullopt;
    }

    auto board_opt = ChessBoard::from_fen(start_fen);
    if (!board_opt.has_value()) {
        error_out = "Invalid starting FEN.";
        return std::nullopt;
    }

    ChessBoard board = *board_opt;
    std::vector<MoveStep> steps;
    steps.reserve(inputs.size());

    for (std::size_t i = 0; i < inputs.size(); ++i) {
        std::optional<MoveResult> res = board.make_uci_move(inputs[i].move);
        if (!res.has_value()) {
            res = board.make_san_move(inputs[i].move);
        }
        if (!res.has_value()) {
            error_out = "Illegal move at ply " + std::to_string(i + 1) + ": " + inputs[i].move;
            return std::nullopt;
        }
        steps.push_back(MoveStep{
            .uci = res->uci,
            .san = res->san,
            .fen = res->fen,
            .normalized_fen = res->normalized_fen,
            .description = inputs[i].description,
        });
    }

    return steps;
}

} // namespace

std::string RepertoireGraph::generate_id() {
    return "v" + std::to_string(next_id_++);
}

void RepertoireGraph::add_unique(std::vector<std::string>& vec, const std::string& value) {
    if (std::find(vec.begin(), vec.end(), value) == vec.end()) {
        vec.push_back(value);
    }
}

void RepertoireGraph::remove_value(std::vector<std::string>& vec, std::string_view value) {
    vec.erase(std::remove(vec.begin(), vec.end(), value), vec.end());
}

bool RepertoireGraph::has_path(std::string_view from_id, std::string_view target_id) const {
    if (from_id == target_id) {
        return true;
    }
    std::queue<std::string> q;
    std::unordered_set<std::string> visited;
    q.push(std::string(from_id));
    visited.insert(std::string(from_id));

    while (!q.empty()) {
        const std::string cur = std::move(q.front());
        q.pop();

        const auto it = segments_.find(cur);
        if (it == segments_.end()) {
            continue;
        }
        for (const auto& child_id : it->second.child_ids) {
            if (child_id == target_id) {
                return true;
            }
            if (visited.insert(child_id).second) {
                q.push(child_id);
            }
        }
    }
    return false;
}

AddVariantResult RepertoireGraph::add_variant(std::string name, Side side,
                                              std::string_view start_fen,
                                              const std::vector<MoveInput>& moves) {
    std::string err;
    auto steps_opt = build_move_steps(start_fen, moves, err);
    if (!steps_opt.has_value()) {
        return AddVariantResult{.ok = false, .error = err};
    }

    const auto start_board = ChessBoard::from_fen(start_fen);
    const std::string norm_start = start_board->normalized_fen();
    const std::vector<MoveStep>& steps = *steps_opt;

    // Look for an existing segment of the same side that already contains this starting position
    // and matches at least the first move, so we can walk down the DAG and split if needed.
    std::string cur_seg_id;
    std::size_t cur_ply = 0;

    for (const auto& [id, seg] : segments_) {
        if (seg.side != side || seg.moves.empty()) {
            continue;
        }
        if (seg.start_normalized_fen == norm_start && seg.moves[0].uci == steps[0].uci) {
            cur_seg_id = id;
            cur_ply = 0;
            break;
        }
        for (std::size_t i = 0; i + 1 < seg.moves.size(); ++i) {
            if (seg.moves[i].normalized_fen == norm_start && seg.moves[i + 1].uci == steps[0].uci) {
                cur_seg_id = id;
                cur_ply = i + 1;
                break;
            }
        }
        if (!cur_seg_id.empty()) {
            break;
        }
    }

    // Walk along matching moves in the existing DAG.
    if (!cur_seg_id.empty()) {
        std::size_t step_idx = 0;
        while (step_idx < steps.size()) {
            const VariantSegment& seg = segments_.at(cur_seg_id);
            if (cur_ply < seg.moves.size()) {
                if (seg.moves[cur_ply].uci == steps[step_idx].uci) {
                    ++cur_ply;
                    ++step_idx;
                    continue;
                }
                // Diverged inside `cur_seg_id` right after `cur_ply - 1`.
                std::vector<MoveInput> remaining;
                remaining.reserve(steps.size() - step_idx);
                for (std::size_t k = step_idx; k < steps.size(); ++k) {
                    remaining.push_back(moves[k]);
                }
                return branch_from(cur_seg_id, cur_ply - 1, std::move(name), remaining);
            }

            // Reached the end of `cur_seg_id`; check if a child continues with `steps[step_idx]`.
            std::string next_child;
            for (const auto& cid : seg.child_ids) {
                const auto& child = segments_.at(cid);
                if (!child.moves.empty() && child.moves[0].uci == steps[step_idx].uci) {
                    next_child = cid;
                    break;
                }
            }
            if (!next_child.empty()) {
                cur_seg_id = next_child;
                cur_ply = 0;
                continue;
            }

            // No matching child: attach remaining moves as a new child of `cur_seg_id`.
            std::vector<MoveInput> remaining;
            remaining.reserve(steps.size() - step_idx);
            for (std::size_t k = step_idx; k < steps.size(); ++k) {
                remaining.push_back(moves[k]);
            }
            return branch_from(cur_seg_id, seg.moves.size() - 1, std::move(name), remaining);
        }

        // All moves already existed in the DAG.
        return AddVariantResult{
            .ok = true,
            .segment_id = cur_seg_id,
            .split_occurred = false,
        };
    }

    // No overlapping prefix found: create a new root segment.
    const std::string id = generate_id();
    VariantSegment seg;
    seg.id = id;
    seg.name = name.empty() ? ("Variant " + id) : std::move(name);
    seg.side = side;
    seg.start_fen = std::string(start_fen);
    seg.start_normalized_fen = norm_start;
    seg.moves = steps;

    segments_.emplace(id, std::move(seg));
    return AddVariantResult{.ok = true, .segment_id = id, .split_occurred = false};
}

AddVariantResult RepertoireGraph::branch_from(std::string_view parent_segment_id,
                                              std::size_t after_ply, std::string name,
                                              const std::vector<MoveInput>& moves) {
    auto parent_it = segments_.find(std::string(parent_segment_id));
    if (parent_it == segments_.end()) {
        return AddVariantResult{.ok = false, .error = "Parent segment not found."};
    }

    VariantSegment& parent = parent_it->second;
    if (after_ply >= parent.moves.size()) {
        return AddVariantResult{.ok = false, .error = "Branch ply index out of range."};
    }

    const std::string branch_start_fen = parent.moves[after_ply].fen;
    const std::string branch_start_norm_fen = parent.moves[after_ply].normalized_fen;

    std::string err;
    auto steps_opt = build_move_steps(branch_start_fen, moves, err);
    if (!steps_opt.has_value()) {
        return AddVariantResult{.ok = false, .error = err};
    }

    const bool is_interior_split = (after_ply + 1 < parent.moves.size());
    if (is_interior_split) {
        // Move the suffix [after_ply + 1 .. end] into a new child segment that inherits
        // the parent's existing children.
        const std::string suffix_id = generate_id();
        VariantSegment suffix;
        suffix.id = suffix_id;
        suffix.name = parent.name + " (cont.)";
        suffix.side = parent.side;
        suffix.start_fen = branch_start_fen;
        suffix.start_normalized_fen = branch_start_norm_fen;
        suffix.moves.assign(std::make_move_iterator(parent.moves.begin() + after_ply + 1),
                            std::make_move_iterator(parent.moves.end()));
        suffix.parent_ids = {parent.id};
        suffix.child_ids = std::move(parent.child_ids);

        // Re-point existing children from `parent.id` to `suffix_id`.
        for (const auto& cid : suffix.child_ids) {
            if (auto cit = segments_.find(cid); cit != segments_.end()) {
                remove_value(cit->second.parent_ids, parent.id);
                add_unique(cit->second.parent_ids, suffix_id);
            }
        }

        parent.moves.erase(parent.moves.begin() + after_ply + 1, parent.moves.end());
        parent.child_ids = {suffix_id};
        segments_.emplace(suffix_id, std::move(suffix));
    }

    // Create the new branch child segment. Re-fetch `parent` reference safely.
    VariantSegment& parent_ref = segments_.at(std::string(parent_segment_id));
    const std::string branch_id = generate_id();
    VariantSegment branch;
    branch.id = branch_id;
    branch.name = name.empty() ? ("Variant " + branch_id) : std::move(name);
    branch.side = parent_ref.side;
    branch.start_fen = branch_start_fen;
    branch.start_normalized_fen = branch_start_norm_fen;
    branch.moves = std::move(*steps_opt);
    branch.parent_ids = {parent_ref.id};

    add_unique(parent_ref.child_ids, branch_id);
    const std::string parent_id_copy = parent_ref.id;
    segments_.emplace(branch_id, std::move(branch));

    return AddVariantResult{
        .ok = true,
        .segment_id = branch_id,
        .split_occurred = is_interior_split,
        .split_parent_id = parent_id_copy,
    };
}

LinkResult RepertoireGraph::link_parent_child(std::string_view parent_id,
                                              std::string_view child_id) {
    auto pit = segments_.find(std::string(parent_id));
    auto cit = segments_.find(std::string(child_id));
    if (pit == segments_.end() || cit == segments_.end()) {
        return LinkResult{.ok = false, .error = "Parent or child segment not found."};
    }

    if (parent_id == child_id || has_path(child_id, parent_id)) {
        return LinkResult{.ok = false, .error = "Linking would introduce a cycle in the DAG."};
    }

    const std::string parent_end = end_normalized_fen(pit->second);
    if (parent_end != cit->second.start_normalized_fen) {
        return LinkResult{
            .ok = false,
            .error = "Parent end position does not match child start position.",
        };
    }

    add_unique(pit->second.child_ids, cit->second.id);
    add_unique(cit->second.parent_ids, pit->second.id);
    return LinkResult{.ok = true};
}

bool RepertoireGraph::rename_variant(std::string_view segment_id, std::string new_name) {
    auto* seg = find_segment_mut(segment_id);
    if (!seg || new_name.empty()) {
        return false;
    }
    seg->name = std::move(new_name);
    return true;
}

bool RepertoireGraph::set_move_description(std::string_view segment_id, std::size_t ply_index,
                                           std::string description) {
    auto* seg = find_segment_mut(segment_id);
    if (!seg || ply_index >= seg->moves.size()) {
        return false;
    }
    seg->moves[ply_index].description = std::move(description);
    return true;
}

bool RepertoireGraph::remove_variant(std::string_view segment_id) {
    auto it = segments_.find(std::string(segment_id));
    if (it == segments_.end()) {
        return false;
    }

    for (const auto& pid : it->second.parent_ids) {
        if (auto pit = segments_.find(pid); pit != segments_.end()) {
            remove_value(pit->second.child_ids, segment_id);
        }
    }
    for (const auto& cid : it->second.child_ids) {
        if (auto cit = segments_.find(cid); cit != segments_.end()) {
            remove_value(cit->second.parent_ids, segment_id);
        }
    }

    segments_.erase(it);
    return true;
}

const VariantSegment* RepertoireGraph::find_segment(std::string_view segment_id) const {
    auto it = segments_.find(std::string(segment_id));
    return it == segments_.end() ? nullptr : &it->second;
}

VariantSegment* RepertoireGraph::find_segment_mut(std::string_view segment_id) {
    auto it = segments_.find(std::string(segment_id));
    return it == segments_.end() ? nullptr : &it->second;
}

std::vector<const VariantSegment*> RepertoireGraph::all_segments() const {
    std::vector<const VariantSegment*> out;
    out.reserve(segments_.size());
    for (const auto& [_, seg] : segments_) {
        out.push_back(&seg);
    }
    std::sort(out.begin(), out.end(),
              [](const VariantSegment* a, const VariantSegment* b) { return a->id < b->id; });
    return out;
}

std::vector<Continuation> RepertoireGraph::continuations_at(std::string_view normalized_fen) const {
    std::vector<Continuation> result;
    std::unordered_set<std::string> seen_uci;

    for (const auto& [_, seg] : segments_) {
        if (seg.moves.empty()) {
            continue;
        }
        if (seg.start_normalized_fen == normalized_fen) {
            if (seen_uci.insert(seg.moves[0].uci).second) {
                result.push_back(Continuation{
                    .uci = seg.moves[0].uci,
                    .san = seg.moves[0].san,
                    .segment_id = seg.id,
                    .ply_index = 0,
                    .description = seg.moves[0].description,
                });
            }
        }
        for (std::size_t i = 0; i + 1 < seg.moves.size(); ++i) {
            if (seg.moves[i].normalized_fen == normalized_fen) {
                if (seen_uci.insert(seg.moves[i + 1].uci).second) {
                    result.push_back(Continuation{
                        .uci = seg.moves[i + 1].uci,
                        .san = seg.moves[i + 1].san,
                        .segment_id = seg.id,
                        .ply_index = i + 1,
                        .description = seg.moves[i + 1].description,
                    });
                }
            }
        }
    }
    return result;
}

std::string RepertoireGraph::position_before_ply(const VariantSegment& segment,
                                                 std::size_t ply_index) {
    if (ply_index == 0) {
        return segment.start_normalized_fen;
    }
    return segment.moves[ply_index - 1].normalized_fen;
}

std::string RepertoireGraph::fen_before_ply(const VariantSegment& segment, std::size_t ply_index) {
    if (ply_index == 0) {
        return segment.start_fen;
    }
    return segment.moves[ply_index - 1].fen;
}

std::string RepertoireGraph::end_normalized_fen(const VariantSegment& segment) {
    if (segment.moves.empty()) {
        return segment.start_normalized_fen;
    }
    return segment.moves.back().normalized_fen;
}

std::string RepertoireGraph::end_fen(const VariantSegment& segment) {
    if (segment.moves.empty()) {
        return segment.start_fen;
    }
    return segment.moves.back().fen;
}

void RepertoireGraph::clear() {
    segments_.clear();
    next_id_ = 1;
}

void RepertoireGraph::insert_raw_segment(VariantSegment segment) {
    const std::string id = segment.id;
    segments_.emplace(id, std::move(segment));
}

void RepertoireGraph::set_next_id_counter(std::uint64_t next_id) {
    next_id_ = next_id;
}

} // namespace dejamove
