#pragma once

#include "dejamove/repertoire_graph.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <random>
#include <string>
#include <string_view>
#include <vector>

namespace dejamove {

/**
 * @brief Pluggable interface for computing time-decayed knowledge scores and post-session updates.
 */
class ScoringStrategy {
  public:
    virtual ~ScoringStrategy() = default;

    [[nodiscard]] virtual double effective_score(const VariantStats& stats,
                                                 std::int64_t now_ms) const = 0;

    [[nodiscard]] virtual VariantStats update_stats(const VariantStats& previous, bool passed,
                                                    double avg_ms_per_move,
                                                    std::int64_t now_ms) const = 0;
};

/**
 * @brief Default exponential-decay scoring with per-move speed bonus and failure penalty.
 */
class DefaultScoringStrategy final : public ScoringStrategy {
  public:
    explicit DefaultScoringStrategy(double half_life_days = 14.0);

    [[nodiscard]] double effective_score(const VariantStats& stats,
                                         std::int64_t now_ms) const override;

    [[nodiscard]] VariantStats update_stats(const VariantStats& previous, bool passed,
                                            double avg_ms_per_move,
                                            std::int64_t now_ms) const override;

  private:
    double decay_lambda_per_day_;
};

struct PlayedMoveRecord {
    std::string uci;
    std::string san;
    std::string fen;
    std::string description;
    Side by_side = Side::White;
    bool is_user_move = false;
    bool was_mistake = false;
};

struct ExpectedMoveOption {
    std::string uci;
    std::string san;
    std::string description;
    std::string target_segment_id;
    std::size_t target_ply_index = 0;
};

struct SegmentVisit {
    std::string segment_id;
    bool failed = false;
    std::uint32_t user_moves = 0;
    std::int64_t total_user_ms = 0;
};

struct SegmentScoreDelta {
    std::string segment_id;
    std::string name;
    bool passed = true;
    double previous_score = 0.0;
    double new_score = 0.0;
};

struct TrainingSessionState {
    bool active = false;
    bool completed = false;
    bool awaiting_mistake_advance = false;
    std::string start_segment_id;
    std::string current_segment_id;
    std::size_t current_ply_index =
        0; // Next ply to be played in current_segment_id (or size() if at boundary)
    Side user_side = Side::White;
    std::string start_fen;
    std::string current_fen;
    std::vector<PlayedMoveRecord> history;
    std::vector<SegmentVisit> visits;
    std::vector<ExpectedMoveOption> pending_expected_moves;
    std::vector<SegmentScoreDelta> score_deltas;
};

struct SubmitMoveResult {
    bool accepted = false; // False if not a legal chess move or session not awaiting user move
    bool correct = false;
    std::string error;
    std::vector<ExpectedMoveOption> expected_moves;
    TrainingSessionState state;
};

/**
 * @brief Drives interactive opening training sessions over a RepertoireGraph.
 */
class TrainingEngine {
  public:
    explicit TrainingEngine(std::shared_ptr<const ScoringStrategy> scoring =
                                std::make_shared<DefaultScoringStrategy>());

    [[nodiscard]] double effective_score(const VariantStats& stats, std::int64_t now_ms) const;

    /**
     * @brief Selects a segment probabilistically, preferring lower effective knowledge scores.
     */
    [[nodiscard]] const VariantSegment* pick_smart_random_segment(const RepertoireGraph& graph,
                                                                  std::int64_t now_ms,
                                                                  std::optional<Side> side_filter,
                                                                  std::mt19937_64& rng) const;

    /**
     * @brief Starts a training session at `segment_id` and auto-plays any leading opponent moves.
     */
    std::optional<TrainingSessionState> start_session(const RepertoireGraph& graph,
                                                      std::string_view segment_id,
                                                      std::mt19937_64& rng) const;

    /**
     * @brief Submits the user's move. Updates `graph` stats automatically if the line finishes.
     */
    SubmitMoveResult submit_move(RepertoireGraph& graph, TrainingSessionState& session,
                                 std::string_view uci_or_san, std::int64_t elapsed_ms,
                                 std::int64_t now_ms, std::mt19937_64& rng) const;

    /**
     * @brief Advances past a wrong move along the expected line and resumes until the next user
     * turn or completion.
     */
    TrainingSessionState advance_after_mistake(RepertoireGraph& graph,
                                               TrainingSessionState& session, std::int64_t now_ms,
                                               std::mt19937_64& rng) const;

  private:
    struct NextStepCandidate {
        std::string segment_id;
        std::size_t ply_index = 0;
        MoveStep step;
    };

    [[nodiscard]] std::vector<NextStepCandidate>
    next_candidates(const RepertoireGraph& graph, const TrainingSessionState& session) const;

    void advance_opponent_moves(const RepertoireGraph& graph, TrainingSessionState& session,
                                std::mt19937_64& rng) const;

    void apply_step(TrainingSessionState& session, const NextStepCandidate& cand, bool is_user_move,
                    bool was_mistake) const;

    void finalize_session(RepertoireGraph& graph, TrainingSessionState& session,
                          std::int64_t now_ms) const;

    void ensure_visit(TrainingSessionState& session, std::string_view segment_id) const;

    std::shared_ptr<const ScoringStrategy> scoring_;
};

} // namespace dejamove
