#include "dejamove/training_engine.hpp"

#include <algorithm>
#include <cmath>

namespace dejamove {

namespace {

constexpr double kMsPerDay = 86'400'000.0;
constexpr double kLn2 = 0.6931471805599453;

double compute_speed_bonus(double avg_ms_per_move) {
    if (avg_ms_per_move <= 0.0) {
        return 0.0;
    }
    if (avg_ms_per_move <= 2000.0) {
        return 10.0;
    }
    if (avg_ms_per_move >= 10000.0) {
        return 0.0;
    }
    return 10.0 * (10000.0 - avg_ms_per_move) / 8000.0;
}

} // namespace

DefaultScoringStrategy::DefaultScoringStrategy(double half_life_days)
    : decay_lambda_per_day_(half_life_days > 0.0 ? (kLn2 / half_life_days) : 0.0) {}

double DefaultScoringStrategy::effective_score(const VariantStats& stats,
                                               std::int64_t now_ms) const {
    if (stats.attempts == 0 || stats.last_practiced_ms <= 0 || now_ms <= stats.last_practiced_ms) {
        return std::clamp(stats.score, 0.0, 100.0);
    }
    const double elapsed_days = static_cast<double>(now_ms - stats.last_practiced_ms) / kMsPerDay;
    const double decayed = stats.score * std::exp(-decay_lambda_per_day_ * elapsed_days);
    return std::clamp(decayed, 0.0, 100.0);
}

VariantStats DefaultScoringStrategy::update_stats(const VariantStats& previous, bool passed,
                                                  double avg_ms_per_move,
                                                  std::int64_t now_ms) const {
    const double decayed = effective_score(previous, now_ms);
    VariantStats next = previous;
    next.attempts += 1;
    next.last_practiced_ms = now_ms;

    if (passed) {
        next.successes += 1;
        next.streak += 1;
        const double streak_bonus = std::min(10.0, static_cast<double>(next.streak) * 2.0);
        const double speed_bonus = compute_speed_bonus(avg_ms_per_move);
        const double gain = 15.0 + streak_bonus + speed_bonus;
        next.score = std::clamp(decayed + gain, 0.0, 100.0);
    } else {
        next.streak = 0;
        next.score = std::clamp(decayed * 0.6 - 5.0, 0.0, 100.0);
    }
    return next;
}

TrainingEngine::TrainingEngine(std::shared_ptr<const ScoringStrategy> scoring)
    : scoring_(std::move(scoring)) {}

double TrainingEngine::effective_score(const VariantStats& stats, std::int64_t now_ms) const {
    return scoring_->effective_score(stats, now_ms);
}

const VariantSegment* TrainingEngine::pick_smart_random_segment(const RepertoireGraph& graph,
                                                                std::int64_t now_ms,
                                                                std::optional<Side> side_filter,
                                                                std::mt19937_64& rng) const {
    std::vector<const VariantSegment*> candidates;
    std::vector<double> weights;

    for (const VariantSegment* seg : graph.all_segments()) {
        if (seg->moves.empty()) {
            continue;
        }
        if (side_filter.has_value() && seg->side != *side_filter) {
            continue;
        }
        const double eff = effective_score(seg->stats, now_ms);
        const double deficit = std::max(0.0, 100.0 - eff);
        const double weight = (deficit * deficit) + 5.0;
        candidates.push_back(seg);
        weights.push_back(weight);
    }

    if (candidates.empty()) {
        return nullptr;
    }

    std::discrete_distribution<std::size_t> dist(weights.begin(), weights.end());
    return candidates[dist(rng)];
}

std::vector<TrainingEngine::NextStepCandidate>
TrainingEngine::next_candidates(const RepertoireGraph& graph,
                                const TrainingSessionState& session) const {
    std::vector<NextStepCandidate> out;
    const auto* seg = graph.find_segment(session.current_segment_id);
    if (!seg) {
        return out;
    }

    if (session.current_ply_index < seg->moves.size()) {
        out.push_back(NextStepCandidate{
            .segment_id = seg->id,
            .ply_index = session.current_ply_index,
            .step = seg->moves[session.current_ply_index],
        });
        return out;
    }

    for (const auto& cid : seg->child_ids) {
        const auto* child = graph.find_segment(cid);
        if (child && !child->moves.empty()) {
            out.push_back(NextStepCandidate{
                .segment_id = child->id,
                .ply_index = 0,
                .step = child->moves[0],
            });
        }
    }
    return out;
}

void TrainingEngine::ensure_visit(TrainingSessionState& session,
                                  std::string_view segment_id) const {
    for (const auto& v : session.visits) {
        if (v.segment_id == segment_id) {
            return;
        }
    }
    session.visits.push_back(SegmentVisit{.segment_id = std::string(segment_id)});
}

void TrainingEngine::apply_step(TrainingSessionState& session, const NextStepCandidate& cand,
                                bool is_user_move, bool was_mistake) const {
    ensure_visit(session, cand.segment_id);

    const auto board_before = ChessBoard::from_fen(session.current_fen);
    const Side mover = board_before.has_value() ? board_before->side_to_move() : session.user_side;

    session.current_segment_id = cand.segment_id;
    session.current_ply_index = cand.ply_index + 1;
    session.current_fen = cand.step.fen;
    session.history.push_back(PlayedMoveRecord{
        .uci = cand.step.uci,
        .san = cand.step.san,
        .fen = cand.step.fen,
        .description = cand.step.description,
        .by_side = mover,
        .is_user_move = is_user_move,
        .was_mistake = was_mistake,
    });
}

void TrainingEngine::advance_opponent_moves(const RepertoireGraph& graph,
                                            TrainingSessionState& session,
                                            std::mt19937_64& rng) const {
    while (true) {
        const auto board = ChessBoard::from_fen(session.current_fen);
        if (!board.has_value()) {
            session.completed = true;
            session.active = false;
            return;
        }
        const auto candidates = next_candidates(graph, session);
        if (candidates.empty()) {
            session.completed = true;
            session.active = false;
            return;
        }
        if (board->side_to_move() == session.user_side) {
            return;
        }
        std::uniform_int_distribution<std::size_t> dist(0, candidates.size() - 1);
        const auto& chosen = candidates[dist(rng)];
        apply_step(session, chosen, false, false);
    }
}

void TrainingEngine::finalize_session(RepertoireGraph& graph, TrainingSessionState& session,
                                      std::int64_t now_ms) const {
    session.active = false;
    session.completed = true;
    session.score_deltas.clear();

    for (const auto& visit : session.visits) {
        auto* seg = graph.find_segment_mut(visit.segment_id);
        if (!seg) {
            continue;
        }
        const double prev_eff = scoring_->effective_score(seg->stats, now_ms);
        const double avg_ms = visit.user_moves > 0 ? static_cast<double>(visit.total_user_ms) /
                                                         static_cast<double>(visit.user_moves)
                                                   : 0.0;
        const bool passed = !visit.failed;
        seg->stats = scoring_->update_stats(seg->stats, passed, avg_ms, now_ms);

        session.score_deltas.push_back(SegmentScoreDelta{
            .segment_id = seg->id,
            .name = graph.display_name(seg->id),
            .passed = passed,
            .previous_score = prev_eff,
            .new_score = seg->stats.score,
        });
    }
}

std::optional<TrainingSessionState> TrainingEngine::start_session(const RepertoireGraph& graph,
                                                                  std::string_view segment_id,
                                                                  std::mt19937_64& rng) const {
    const auto* seg = graph.find_segment(segment_id);
    if (!seg || seg->moves.empty()) {
        return std::nullopt;
    }

    TrainingSessionState session;
    session.active = true;
    session.start_segment_id = seg->id;
    session.current_segment_id = seg->id;
    session.current_ply_index = 0;
    session.user_side = seg->side;
    session.start_fen = seg->start_fen;
    session.current_fen = seg->start_fen;
    ensure_visit(session, seg->id);

    advance_opponent_moves(graph, session, rng);
    return session;
}

SubmitMoveResult TrainingEngine::submit_move(RepertoireGraph& graph, TrainingSessionState& session,
                                             std::string_view uci_or_san, std::int64_t elapsed_ms,
                                             std::int64_t now_ms, std::mt19937_64& rng) const {
    if (!session.active || session.completed || session.awaiting_mistake_advance) {
        return SubmitMoveResult{
            .accepted = false,
            .error = "Session is not awaiting a user move.",
            .state = session,
        };
    }

    auto board = ChessBoard::from_fen(session.current_fen);
    if (!board.has_value() || board->side_to_move() != session.user_side) {
        return SubmitMoveResult{
            .accepted = false,
            .error = "Not the user's turn.",
            .state = session,
        };
    }

    auto move_res = board->make_uci_move(uci_or_san);
    if (!move_res.has_value()) {
        move_res = board->make_san_move(uci_or_san);
    }
    if (!move_res.has_value()) {
        return SubmitMoveResult{
            .accepted = false,
            .error = "Illegal chess move.",
            .state = session,
        };
    }

    const auto candidates = next_candidates(graph, session);
    if (candidates.empty()) {
        finalize_session(graph, session, now_ms);
        return SubmitMoveResult{.accepted = true, .correct = true, .state = session};
    }

    for (const auto& cand : candidates) {
        if (cand.step.uci == move_res->uci) {
            ensure_visit(session, cand.segment_id);
            for (auto& v : session.visits) {
                if (v.segment_id == cand.segment_id) {
                    v.user_moves += 1;
                    v.total_user_ms += std::max<std::int64_t>(0, elapsed_ms);
                    break;
                }
            }

            apply_step(session, cand, true, false);
            advance_opponent_moves(graph, session, rng);
            if (session.completed) {
                finalize_session(graph, session, now_ms);
            }
            return SubmitMoveResult{.accepted = true, .correct = true, .state = session};
        }
    }

    // Wrong move (legal in chess, but not in repertoire).
    for (auto& v : session.visits) {
        if (v.segment_id == session.current_segment_id) {
            v.failed = true;
            break;
        }
    }

    session.awaiting_mistake_advance = true;
    session.pending_expected_moves.clear();
    for (const auto& cand : candidates) {
        session.pending_expected_moves.push_back(ExpectedMoveOption{
            .uci = cand.step.uci,
            .san = cand.step.san,
            .description = cand.step.description,
            .target_segment_id = cand.segment_id,
            .target_ply_index = cand.ply_index,
        });
    }

    return SubmitMoveResult{
        .accepted = true,
        .correct = false,
        .expected_moves = session.pending_expected_moves,
        .state = session,
    };
}

TrainingSessionState TrainingEngine::advance_after_mistake(RepertoireGraph& graph,
                                                           TrainingSessionState& session,
                                                           std::int64_t now_ms,
                                                           std::mt19937_64& rng) const {
    if (!session.awaiting_mistake_advance || session.pending_expected_moves.empty()) {
        return session;
    }

    const auto candidates = next_candidates(graph, session);
    if (!candidates.empty()) {
        const auto& chosen = candidates.front();
        apply_step(session, chosen, true, true);
        // Mark the target segment as failed if we just stepped into a child segment.
        for (auto& v : session.visits) {
            if (v.segment_id == chosen.segment_id) {
                v.failed = true;
                break;
            }
        }
    }

    session.awaiting_mistake_advance = false;
    session.pending_expected_moves.clear();

    advance_opponent_moves(graph, session, rng);
    if (session.completed) {
        finalize_session(graph, session, now_ms);
    }
    return session;
}

} // namespace dejamove
