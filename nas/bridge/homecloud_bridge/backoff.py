"""Exponential backoff with jitter, shared by the HA and IoT reconnect loops."""
import random

MAX_DELAY = 60.0


def backoff_delay(attempt: int, base: float = 1.0, cap: float = MAX_DELAY) -> float:
    """Delay before retry number `attempt` (0-based): base*2^n capped, jittered to [50%, 100%]."""
    raw = min(cap, base * (2 ** min(attempt, 30)))
    return raw / 2 + random.random() * raw / 2
