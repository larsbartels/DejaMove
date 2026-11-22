#pragma once

#include "dejamove/chess_board.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace dejamove {

struct MoveStep {
    std::string uci;
    std::string san;
    std::string fen;
    std::string normalized_fen;
    std::string description;
};

struct VariantStats {
    double score = 0.0; // 0.0 .. 100.0
    std::uint32_t attempts = 0;
    std::uint32_t successes = 0;
    std::uint32_t streak = 0;
    std::int64_t last_practiced_ms = 0;
};

struct VariantSegment {
    std::string id;
    std::string name;
    Side side = Side::White;
    std::string start_fen;
    std::string start_normalized_fen;
    std::vector<MoveStep> moves;
    std::vector<std::string> parent_ids;
    std::vector<std::string> child_ids;
    VariantStats stats;
};

struct MoveInput {
    std::string move; // UCI or SAN
    std::string description;
};

struct Continuation {
    std::string uci;
    std::string san;
    std::string segment_id;
    std::size_t ply_index = 0;
    std::string description;
};

enum class PositionMatchKind { Start, Interior, End };

struct PositionMatch {
    std::string segment_id;
    std::string segment_name;
    Side side = Side::White;
    std::size_t ply_index = 0; // 0 = start_fen, 1..moves.size() = after moves[ply_index - 1]
    PositionMatchKind match_kind = PositionMatchKind::Start;
    std::string move_san;      // Empty when ply_index == 0
    std::string next_move_san; // Empty when ply_index == moves.size()
};

struct AddVariantResult {
    bool ok = false;
    std::string error;
    std::string segment_id; // Created or matched leaf segment id
    bool split_occurred = false;
    std::string split_parent_id;
};

struct LinkResult {
    bool ok = false;
    std::string error;
};

/**
 * @brief Directed Acyclic Graph (DAG) of opening variant segments.
 *
 * Supports automatic splitting when a new line diverges inside an existing segment,
 * as well as multiple parent segments linking to a shared child segment (transpositions),
 * while enforcing acyclicity.
 */
class RepertoireGraph {
  public:
    RepertoireGraph() = default;

    /**
     * @brief Adds a new variant starting from `start_fen`.
     *
     * If `start_fen` and a prefix of `moves` match an existing segment (either from its start
     * or from an interior position), the existing segment is automatically split at the
     * divergence point into a shared parent and child branches.
     */
    AddVariantResult add_variant(std::string name, Side side, std::string_view start_fen,
                                 const std::vector<MoveInput>& moves);

    /**
     * @brief Branches from an existing segment after `after_ply` (0-indexed) with `moves`.
     *
     * If `after_ply` is before the end of `parent_segment_id`, that segment splits into
     * `[0..after_ply]` and `[after_ply+1..end]` plus the new branch.
     */
    AddVariantResult branch_from(std::string_view parent_segment_id, std::size_t after_ply,
                                 std::string name, const std::vector<MoveInput>& moves);

    /**
     * @brief Links an existing parent segment to an existing child segment (multi-parent DAG).
     *
     * Fails if either segment does not exist, if the parent's final position does not match
     * the child's starting position, or if linking would introduce a cycle.
     */
    LinkResult link_parent_child(std::string_view parent_id, std::string_view child_id);

    bool rename_variant(std::string_view segment_id, std::string new_name);
    bool set_move_description(std::string_view segment_id, std::size_t ply_index,
                              std::string description);
    bool remove_variant(std::string_view segment_id);

    [[nodiscard]] const VariantSegment* find_segment(std::string_view segment_id) const;
    [[nodiscard]] VariantSegment* find_segment_mut(std::string_view segment_id);
    [[nodiscard]] std::vector<const VariantSegment*> all_segments() const;

    /**
     * @brief Returns all defined repertoire continuations from any position (by normalized FEN).
     */
    [[nodiscard]] std::vector<Continuation> continuations_at(std::string_view normalized_fen) const;

    /**
     * @brief Finds every variant segment and ply index whose position matches `normalized_fen`.
     */
    [[nodiscard]] std::vector<PositionMatch>
    find_positions_by_fen(std::string_view normalized_fen) const;

    /**
     * @brief Returns the normalized FEN of the position right before `ply_index` in `segment`.
     */
    [[nodiscard]] static std::string position_before_ply(const VariantSegment& segment,
                                                         std::size_t ply_index);

    /**
     * @brief Returns the full FEN of the position right before `ply_index` in `segment`.
     */
    [[nodiscard]] static std::string fen_before_ply(const VariantSegment& segment,
                                                    std::size_t ply_index);

    /**
     * @brief Returns the final normalized FEN after all moves in `segment`.
     */
    [[nodiscard]] static std::string end_normalized_fen(const VariantSegment& segment);

    /**
     * @brief Returns the final full FEN after all moves in `segment`.
     */
    [[nodiscard]] static std::string end_fen(const VariantSegment& segment);

    void clear();
    [[nodiscard]] std::size_t size() const {
        return segments_.size();
    }

    // Used by persistence to restore segments with their original IDs.
    void insert_raw_segment(VariantSegment segment);
    void set_next_id_counter(std::uint64_t next_id);
    [[nodiscard]] std::uint64_t next_id_counter() const {
        return next_id_;
    }

  private:
    std::string generate_id();
    [[nodiscard]] bool has_path(std::string_view from_id, std::string_view target_id) const;
    static void add_unique(std::vector<std::string>& vec, const std::string& value);
    static void remove_value(std::vector<std::string>& vec, std::string_view value);

    std::unordered_map<std::string, VariantSegment> segments_;
    std::uint64_t next_id_ = 1;
};

} // namespace dejamove
