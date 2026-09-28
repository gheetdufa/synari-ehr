"""Keyword screening of client-written messages for crisis language.

This is a safety net, not a clinical assessment: it errs toward flagging (negations such as
"I don't want to kill myself" still match) so a clinician never misses a message that may
need urgent attention. Matching is case-insensitive, on whole words, and tolerant of missing
apostrophes ("dont") and hyphen/space variants ("self-harm", "self harm").
"""

import re
from collections.abc import Iterable

from synari.models.enums import RiskLevel

# Suicidal ideation, self-harm, intent to harm others and imminent danger.
HIGH_RISK_PHRASES: tuple[str, ...] = (
    # Suicidal ideation
    "suicide",
    "suicidal",
    "kill myself",
    "killing myself",
    "end my life",
    "ending my life",
    "take my own life",
    "take my life",
    "end it all",
    "want to die",
    "wanna die",
    "going to die tonight",
    "wish I was dead",
    "wish I were dead",
    "wish I could die",
    "better off dead",
    "better off without me",
    "no reason to live",
    "nothing to live for",
    "don't want to live",
    "don't want to be alive",
    "don't want to wake up",
    "no one would miss me",
    "nobody would miss me",
    "suicide note",
    "goodbye forever",
    # Self-harm
    "hurt myself",
    "hurting myself",
    "harm myself",
    "harming myself",
    "self harm",
    "self harming",
    "cut myself",
    "cutting myself",
    "overdose",
    "overdosing",
    "overdosed",
    "took all my pills",
    "take all my pills",
    # Harm to others
    "kill him",
    "kill her",
    "kill them",
    "kill someone",
    "kill somebody",
    "kill everyone",
    "hurt someone",
    "hurt somebody",
    "hurt people",
    # Imminent danger
    "not safe right now",
    "I'm not safe",
    "I am not safe",
    "I'm in danger",
    "I am in danger",
    "have a gun",
    "bought a gun",
)

# Hopelessness and crisis language that warrants the clinician's attention.
MODERATE_RISK_PHRASES: tuple[str, ...] = (
    "hopeless",
    "hopelessness",
    "worthless",
    "no way out",
    "can't go on",
    "can't take it anymore",
    "can't take this anymore",
    "can't do this anymore",
    "can't cope",
    "giving up",
    "give up on everything",
    "I'm a burden",
    "a burden to everyone",
    "no point anymore",
    "what's the point",
    "falling apart",
    "breaking down",
    "trapped",
    "crisis",
    "emergency",
    "panic attack",
    "relapsed",
    "relapse",
)


def _compile(phrases: Iterable[str]) -> re.Pattern[str]:
    alternatives = []
    for phrase in phrases:
        words = [re.escape(word).replace("'", "'?") for word in phrase.split()]
        alternatives.append(r"[\s-]+".join(words))
    return re.compile(r"\b(?:" + "|".join(alternatives) + r")\b", re.IGNORECASE)


_HIGH_RISK = _compile(HIGH_RISK_PHRASES)
_MODERATE_RISK = _compile(MODERATE_RISK_PHRASES)
# Curly quote and modifier-letter apostrophe code points, normalized to a plain '.
_CURLY_APOSTROPHES = str.maketrans(dict.fromkeys((0x2018, 0x2019, 0x02BC), "'"))


def assess_risk(text: str) -> RiskLevel:
    """Risk level of a client-written message based on crisis phrases it contains."""
    normalized = text.translate(_CURLY_APOSTROPHES)
    if _HIGH_RISK.search(normalized):
        return RiskLevel.HIGH
    if _MODERATE_RISK.search(normalized):
        return RiskLevel.MODERATE
    return RiskLevel.NONE
