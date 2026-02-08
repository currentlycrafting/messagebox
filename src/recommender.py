from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from typing import Any, Optional


_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_TOP250_PATH = os.path.join(_BASE_DIR, "movie_database_top250.json")


def _norm_title(title: str) -> str:
    return (title or "").strip().lower()


def _movie_key(title: str, year: str) -> str:
    return f"{_norm_title(title)}::{(year or '').strip()}"


def _is_englishish_title(title: str) -> bool:
    """
    Heuristic filter to drop "foreign-looking" titles.
    User requested removing foreign names from the local Top-250 dataset.
    """
    t = (title or "").strip()
    if not t:
        return False
    # Keep ASCII-only titles (includes common punctuation / numbers).
    try:
        t.encode("ascii")
    except Exception:
        return False
    return True


@dataclass(frozen=True)
class Movie:
    title: str
    year: str
    genres: tuple[str, ...]
    actors: tuple[str, ...]
    directors: tuple[str, ...]
    imdb_url: str
    poster_url: str
    imdb_rating: Optional[float]

    @property
    def key(self) -> str:
        return _movie_key(self.title, self.year)


def load_top250() -> list[Movie]:
    raw = json.loads(open(_TOP250_PATH, "r", encoding="utf-8").read())
    out: list[Movie] = []
    for m in raw:
        title = str(m.get("title", "")).strip()
        poster_url = str(m.get("poster_url", "")).strip()
        if not _is_englishish_title(title):
            continue
        if not poster_url.startswith("http"):
            # User requested removing movies without posters from the local DB.
            continue
        out.append(
            Movie(
                title=title,
                year=str(m.get("year", "")).strip(),
                genres=tuple(str(g).strip() for g in (m.get("genres") or []) if str(g).strip()),
                actors=tuple(str(a).strip() for a in (m.get("actors") or []) if str(a).strip()),
                directors=tuple(str(d).strip() for d in (m.get("directors") or []) if str(d).strip()),
                imdb_url=str(m.get("imdb_url", "")).strip(),
                poster_url=poster_url,
                imdb_rating=(float(m["imdb_rating"]) if isinstance(m.get("imdb_rating"), (int, float)) else None),
            )
        )
    # User wants the IMDb "Top 100" pool. We approximate this by taking the top
    # 100 highest-rated movies from the local IMDb-derived dataset.
    out.sort(key=lambda mv: (mv.imdb_rating or 0.0), reverse=True)
    return out[:100]


def index_by_key(movies: list[Movie]) -> dict[str, Movie]:
    return {m.key: m for m in movies if m.title}


def parse_rating(value: Any) -> Optional[float]:
    """
    Try to parse a rating from a watch-history CSV row. Supports:
    - 0..5 stars
    - 0..10 ratings
    """
    if value is None:
        return None
    try:
        s = str(value).strip()
        if not s:
            return None
        # common letterboxd export: '3.5'
        r = float(s)
        return r
    except Exception:
        return None


def rating_weight(rating: Optional[float]) -> float:
    """
    Convert a rating into a multiplier for preference aggregation.
    Unknown rating -> 1.0
    """
    if rating is None:
        return 1.0
    r = float(rating)
    # Try to infer scale: <= 5 likely star rating, else 10-scale
    if r <= 5.0:
        # Map 0..5 -> 0.75..1.35
        return 0.75 + (max(0.0, min(r, 5.0)) / 5.0) * 0.60
    # Map 0..10 -> 0.75..1.35
    return 0.75 + (max(0.0, min(r, 10.0)) / 10.0) * 0.60


def _normalize_profile(raw: dict[str, float]) -> dict[str, float]:
    if not raw:
        return {}
    max_v = max(raw.values()) if raw else 0.0
    if max_v <= 0:
        return {k: 0.0 for k in raw}
    return {k: max(0.0, min(v / max_v, 1.0)) for k, v in raw.items()}


def _entropy_norm(dist: dict[str, float]) -> float:
    """
    Return normalized entropy 0..1 for a distribution (higher = more diverse).
    """
    total = sum(max(0.0, v) for v in dist.values())
    if total <= 0:
        return 0.0
    probs = [max(0.0, v) / total for v in dist.values() if v > 0]
    if not probs:
        return 0.0
    h = -sum(p * math.log(p) for p in probs)
    h_max = math.log(len(probs)) if len(probs) > 1 else 1.0
    return max(0.0, min(h / h_max, 1.0))


def analyze_user_history(
    watched_keys: list[str],
    watched_rating_by_key: dict[str, Optional[float]],
    movie_index: dict[str, Movie],
    *,
    liked_keys: list[str] | None = None,
    preferred_actors: list[str] | None = None,
    preferred_directors: list[str] | None = None,
) -> tuple[dict[str, float], dict[str, float], dict[str, float]]:
    genre_raw: dict[str, float] = {}
    actor_raw: dict[str, float] = {}
    director_raw: dict[str, float] = {}

    for k in watched_keys:
        m = movie_index.get(k)
        if not m:
            continue
        w = rating_weight(watched_rating_by_key.get(k))
        for g in m.genres:
            genre_raw[g] = genre_raw.get(g, 0.0) + w
        for a in m.actors[:6]:
            actor_raw[a] = actor_raw.get(a, 0.0) + w * 0.5
        for d in m.directors[:2]:
            director_raw[d] = director_raw.get(d, 0.0) + w * 0.9

    # Feedback: liked movies boost their features
    for k in liked_keys or []:
        m = movie_index.get(k)
        if not m:
            continue
        for g in m.genres:
            genre_raw[g] = genre_raw.get(g, 0.0) + 0.8
        for a in m.actors[:6]:
            actor_raw[a] = actor_raw.get(a, 0.0) + 0.5
        for d in m.directors[:2]:
            director_raw[d] = director_raw.get(d, 0.0) + 0.9

    # Normalize to 0..1
    genre_profile = _normalize_profile(genre_raw)
    actor_profile = _normalize_profile(actor_raw)
    director_profile = _normalize_profile(director_raw)

    # Entropy adjustment: if taste is concentrated, boost top genres slightly
    e = _entropy_norm(genre_raw)
    concentration = 1.0 - e  # 0..1
    if genre_profile:
        for g in list(genre_profile.keys()):
            genre_profile[g] = max(0.0, min(genre_profile[g] * (0.75 + 0.25 * concentration), 1.0))

    # Optional explicit preferences
    for a in preferred_actors or []:
        aa = str(a).strip()
        if aa:
            actor_profile[aa] = 1.0
    for d in preferred_directors or []:
        dd = str(d).strip()
        if dd:
            director_profile[dd] = 1.0

    return genre_profile, actor_profile, director_profile


def score_movie(
    movie: Movie,
    genre_profile: dict[str, float],
    actor_profile: dict[str, float],
    director_profile: dict[str, float],
    *,
    mode: str,
) -> float:
    # Genre match: average of known genre weights
    gs = [genre_profile.get(g, 0.0) for g in movie.genres]
    genre_score = (sum(gs) / len(gs)) if gs else 0.0

    actor_score = 0.0
    if mode == "super":
        as_ = [actor_profile.get(a, 0.0) for a in movie.actors[:8]]
        actor_score = (sum(as_) / len(as_)) if as_ else 0.0

    director_score = 0.0
    if mode == "super":
        ds_ = [director_profile.get(d, 0.0) for d in movie.directors[:2]]
        director_score = (sum(ds_) / len(ds_)) if ds_ else 0.0

    base = 0.78 * genre_score + 0.12 * actor_score + 0.10 * director_score
    # Prefer highly rated, mainstream picks
    if movie.imdb_rating is not None:
        base += (max(0.0, min(movie.imdb_rating, 10.0)) - 8.0) * 0.06
    # Strongly prefer having a known poster URL
    if movie.poster_url and movie.poster_url.startswith("http"):
        base += 0.12
    else:
        base -= 0.18
    return base


def recommend_batch(
    candidates: list[Movie],
    *,
    watched_keys: set[str],
    exclude_keys: set[str],
    liked_keys_context: set[str],
    watched_rating_by_key: dict[str, Optional[float]],
    mode: str,
    batch_size: int,
    preferred_actors: list[str] | None = None,
    preferred_directors: list[str] | None = None,
) -> list[dict[str, Any]]:
    mode = "super" if str(mode).strip().lower() == "super" else "regular"
    batch_size = max(1, min(int(batch_size), 60))

    movie_index = index_by_key(candidates)
    watched_list = list(watched_keys)
    liked_list = list(liked_keys_context)

    genre_profile, actor_profile, director_profile = analyze_user_history(
        watched_list,
        watched_rating_by_key,
        movie_index,
        liked_keys=liked_list,
        preferred_actors=preferred_actors,
        preferred_directors=preferred_directors,
    )

    # Filter to unwatched + not excluded
    pool: list[Movie] = []
    for m in candidates:
        k = m.key
        if k in watched_keys:
            continue
        if k in exclude_keys:
            continue
        if k in liked_keys_context:
            continue
        pool.append(m)

    # Round thresholds (regular is stricter)
    thresholds = [0.3, 0.5, 0.6, 0.6, 0.6] if mode == "regular" else [0.25, 0.3, 0.35, 0.35, 0.35]

    # Pre-score everything once
    scored = [(m, score_movie(m, genre_profile, actor_profile, director_profile, mode=mode)) for m in pool]

    # Iteratively tighten and keep best
    working = scored
    for t in thresholds:
        filtered = [(m, s) for (m, s) in working if s >= t]
        if len(filtered) >= batch_size:
            working = filtered
        else:
            # keep what we have; don't collapse to empty
            working = filtered if filtered else working

    # Sort by score desc
    working.sort(key=lambda ms: ms[1], reverse=True)

    # Super mode diversity: greedy pick with genre-penalty to avoid repetition
    selected: list[tuple[Movie, float]] = []
    if mode == "super":
        genre_counts: dict[str, int] = {}

        def diversity_penalty(m: Movie) -> float:
            # penalize overused genres
            p = 0.0
            for g in m.genres:
                p += 0.03 * genre_counts.get(g, 0)
            return p

        for m, s in working:
            if len(selected) >= batch_size:
                break
            s2 = s - diversity_penalty(m)
            selected.append((m, s2))
            for g in m.genres:
                genre_counts[g] = genre_counts.get(g, 0) + 1
        # Re-sort selected by adjusted score for output stability
        selected.sort(key=lambda ms: ms[1], reverse=True)
    else:
        selected = working[:batch_size]

    results: list[dict[str, Any]] = []
    for m, s in selected[:batch_size]:
        why = ""
        if genre_profile and m.genres:
            top_genres = sorted(((g, genre_profile.get(g, 0.0)) for g in m.genres), key=lambda x: x[1], reverse=True)[:2]
            gtxt = ", ".join(g for g, _ in top_genres if g)
            if gtxt:
                why = f"Strong match for your {gtxt} taste."
        results.append(
            {
                "title": m.title,
                "year": m.year,
                "director": (m.directors[0] if m.directors else ""),
                "image": m.poster_url or "logo.svg",
                "why_it_fits": why,
                "_score": round(float(s), 4),
                "_mode": mode,
            }
        )

    return results

