"""Task status state machine (SRS 10.2). All other transitions return 409 INVALID_TRANSITION."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.errors import conflict
from app.models import EventType, TaskStatus as S, User

T = S


@dataclass
class Transition:
    event: str
    closes_timer: bool = False
    requires_reason: bool = False
    requires_note: bool = False


def _all() -> list[str]:
    return list(S)


# (from, to) -> Transition
TRANSITIONS: dict[tuple[str, str], Transition] = {
    (S.todo.value, S.in_progress.value): Transition(EventType.task_status_changed.value),
    (S.todo.value, S.blocked.value): Transition(
        EventType.task_status_changed.value, requires_reason=True
    ),
    (S.todo.value, S.completed.value): Transition(EventType.task_status_changed.value),
    (S.in_progress.value, S.todo.value): Transition(EventType.task_status_changed.value, closes_timer=True),
    (S.in_progress.value, S.blocked.value): Transition(
        EventType.task_status_changed.value, closes_timer=True, requires_reason=True
    ),
    (S.in_progress.value, S.in_review.value): Transition(
        EventType.task_review_requested.value, closes_timer=True
    ),
    (S.in_progress.value, S.completed.value): Transition(EventType.task_status_changed.value, closes_timer=True),
    (S.blocked.value, S.in_progress.value): Transition(EventType.task_status_changed.value),
    (S.blocked.value, S.todo.value): Transition(EventType.task_status_changed.value),
    (S.in_review.value, S.completed.value): Transition(EventType.task_approved.value),
    (S.in_review.value, S.in_progress.value): Transition(EventType.task_revision_requested.value, requires_note=True),
    (S.in_review.value, S.blocked.value): Transition(
        EventType.task_status_changed.value, requires_reason=True
    ),
    (S.completed.value, S.in_progress.value): Transition(
        EventType.task_reopened.value, requires_note=True
    ),
}


def is_reviewer(user: User) -> bool:
    from app import policy

    return policy.is_reviewer(user)


def transition_event(from_status: str, to_status: str, *, by_reviewer: bool) -> str:
    """Most specific event type available for a transition (10.2 naming rule)."""
    rule = TRANSITIONS[(from_status, to_status)]
    if (from_status, to_status) == (S.in_review.value, S.completed.value):
        return EventType.task_approved.value if by_reviewer else rule.event
    if (from_status, to_status) == (S.in_review.value, S.in_progress.value):
        # assignee withdrawing a submission is a plain status change
        return EventType.task_revision_requested.value if by_reviewer else EventType.task_status_changed.value
    return rule.event


def resolve_transition(
    user: User,
    task_status: str,
    to_status: str,
    *,
    requires_review: bool,
    is_assignee: bool,
    note: str | None = None,
    reason: str | None = None,
) -> Transition:
    """Validate a status change.

    Whether this person may change this task at all is decided by
    `policy.can_change_status` before this is called — this function owns the
    state machine (SRS 10.2) and the extra conditions on individual transitions,
    and must never re-derive authority from `user.role`.
    """
    from app import policy
    from app.errors import forbidden

    key = (task_status, to_status)
    if key not in TRANSITIONS:
        raise conflict(
            "INVALID_TRANSITION",
            f"Cannot move a task from {task_status} to {to_status}",
            from_status=task_status,
            to_status=to_status,
        )
    rule = TRANSITIONS[key]

    reviewer = is_reviewer(user)
    lead = policy.is_lead(user)

    # 10.2: withdrawing a submission is the assignee's own move, unless the
    # reviewer is the one sending it back for revision.
    if not reviewer and (task_status, to_status) == (S.in_review.value, S.in_progress.value):
        if not is_assignee:
            raise forbidden("STATUS_NOT_ALLOWED", "Only the assignee may withdraw a submission")

    # 10.2: work that was flagged for review is completed by a reviewer or a lead.
    if to_status == S.completed.value and requires_review and not (reviewer or lead):
        raise forbidden(
            "REVIEW_REQUIRED",
            "This task requires review; ask a reviewer to approve it",
        )

    if rule.requires_reason and (reason is None or len(reason.strip()) < 3):
        raise conflict("REASON_REQUIRED", "A reason of at least 3 characters is required")
    if rule.requires_note and (note is None or not note.strip()):
        raise conflict("NOTE_REQUIRED", "A note is required for this transition")

    return rule