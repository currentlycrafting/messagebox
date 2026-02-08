from __future__ import annotations

import csv
import io
import os
import sqlite3
import time
from typing import Any

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS

from recommender import load_top250 as _load_top250_movies
from recommender import recommend_batch as _recommend_batch
from recommender import analyze_user_history as _analyze_user_history
from recommender import index_by_key as _index_top250_by_key

try:
    # Local module in src/
    from gemini_client import ask_profiles as gemini_ask_profiles
    from gemini_client import ask_super_recommendations as gemini_ask_super_recommendations
    from gemini_client import ask_regular_recommendations as gemini_ask_regular_recommendations
except Exception as import_error:
    print(f"[Gemini] gemini_client import failed: {import_error}", flush=True)
    gemini_ask_profiles = None
    gemini_ask_super_recommendations = None
    gemini_ask_regular_recommendations = None

# Legacy Gemini hooks (deprecated; kept for type-checkers)
gemini_ask_question = None
gemini_ask_recommendations = None


load_dotenv()

TMDB_API_KEY = os.getenv("TMDB_API_KEY", "").strip()

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_FAVICON_SOURCE_SVG = "/Users/someoneguy/Desktop/new_logo.svg"

# Serve files from src/ at the root path (/, /style.css, /recommend.js, /images/...)
app = Flask(
    __name__,
    template_folder=_BASE_DIR,
    static_folder=_BASE_DIR,
    static_url_path="",
)

# ======================
# CORS (SIMPLIFIED)
# ======================
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=True)


@app.after_request
def disable_cache_during_development(response):
    """
    Prevent stale JS/CSS/HTML during local development and Docker iteration.

    This is intentionally minimal and does not handle CORS headers.
    """
    path = request.path or ""
    is_html_or_asset = path == "/" or path.endswith((".html", ".js", ".css", ".svg", ".png", ".ico"))
    is_media = path.startswith(("/images/", "/videos/"))
    if is_html_or_asset or is_media:
        response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/favicon.svg", methods=["GET"])
def favicon_svg():
    """
    Serve the user's preferred SVG favicon from an absolute path.
    Falls back to src/logo.svg if not present.
    """
    try:
        if os.path.exists(_FAVICON_SOURCE_SVG):
            return send_file(_FAVICON_SOURCE_SVG, mimetype="image/svg+xml")
    except Exception:
        pass
    return send_from_directory(_BASE_DIR, "logo.svg", mimetype="image/svg+xml")


@app.route("/favicon.png", methods=["GET"])
def favicon_png():
    """
    Serve PNG favicon. Primary source is src/logo.png.
    """
    try:
        return send_from_directory(_BASE_DIR, "logo.png", mimetype="image/png")
    except Exception:
        return send_from_directory(_BASE_DIR, "logo.svg", mimetype="image/svg+xml")


@app.route("/favicon.ico", methods=["GET"])
def favicon_ico():
    """
    Some browsers aggressively request /favicon.ico regardless of <link rel="icon">.
    Serve our current logo to avoid stale cached icons.
    """
    try:
        # We serve the PNG bytes with an .ico mimetype; most browsers accept this.
        return send_from_directory(_BASE_DIR, "logo.png", mimetype="image/x-icon")
    except Exception:
        return send_from_directory(_BASE_DIR, "logo.svg", mimetype="image/svg+xml")


# ======================
# GLOBAL BACKEND STORAGE
# ======================
watchlist_movies: list[dict[str, Any]] = []
current_recommendations: list[dict[str, Any]] = []
total_movie_click_count: int = 0
tmdb_poster_cache: dict[tuple[str, str], str | None] = {}

# Lightweight local movie metadata cache (SQLite)
_MOVIE_DB_PATH = os.path.join(_BASE_DIR, "movie_cache.sqlite3")

# Internal state: we re-use the most recent "watched list" as Gemini context.
# This is derived from the uploaded CSV.
_last_uploaded_watched_movies_lines: list[str] = []
_last_uploaded_watched_movies: list[dict[str, str]] = []
_last_uploaded_watched_rating_by_key: dict[str, float | None] = {}

_TOP250_MOVIES = None


def _get_top250_movies():
    global _TOP250_MOVIES
    if _TOP250_MOVIES is None:
        _TOP250_MOVIES = _load_top250_movies()
    return _TOP250_MOVIES


def _get_top250_index():
    # Simple derived index for fast lookups
    movies = _get_top250_movies()
    return _index_top250_by_key(movies)


# ======================
# STRING / LIST HELPERS
# ======================
def normalize_movie_title(movie_title: str) -> str:
    """
    Normalize a movie title for case-insensitive comparisons.
    """
    return (movie_title or "").strip().lower()


def _movie_db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_MOVIE_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _movie_db_init(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS movie_cache (
          key TEXT PRIMARY KEY,
          title TEXT,
          year TEXT,
          director TEXT,
          poster_url TEXT,
          updated_at INTEGER
        )
        """
    )
    conn.commit()


def _movie_cache_get_many(keys: list[str]) -> dict[str, dict[str, str]]:
    if not keys:
        return {}
    conn = _movie_db_connect()
    try:
        _movie_db_init(conn)
        placeholders = ",".join(["?"] * len(keys))
        rows = conn.execute(
            f"SELECT key, title, year, director, poster_url FROM movie_cache WHERE key IN ({placeholders})",
            keys,
        ).fetchall()
        out: dict[str, dict[str, str]] = {}
        for r in rows:
            out[str(r["key"])] = {
                "title": str(r["title"] or ""),
                "year": str(r["year"] or ""),
                "director": str(r["director"] or ""),
                "poster_url": str(r["poster_url"] or ""),
            }
        return out
    finally:
        conn.close()


def _movie_cache_upsert_many(movies: list[dict[str, Any]]) -> None:
    if not movies:
        return
    now = int(time.time())
    conn = _movie_db_connect()
    try:
        _movie_db_init(conn)
        for m in movies:
            key = str(m.get("key", "")).strip()
            if not key:
                continue
            title = str(m.get("title", "")).strip()
            year = str(m.get("year", "")).strip()
            director = str(m.get("director", "")).strip()
            poster_url = str(m.get("poster_url", "")).strip()
            conn.execute(
                """
                INSERT INTO movie_cache (key, title, year, director, poster_url, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  title=excluded.title,
                  year=excluded.year,
                  director=COALESCE(NULLIF(excluded.director, ''), movie_cache.director),
                  poster_url=COALESCE(NULLIF(excluded.poster_url, ''), movie_cache.poster_url),
                  updated_at=excluded.updated_at
                """,
                (key, title, year, director, poster_url, now),
            )
        conn.commit()
    finally:
        conn.close()


def get_first_non_empty_value(row: dict[str, Any], candidate_keys: list[str]) -> str:
    """
    Return the first non-empty string value from a CSV row for a list of keys.
    """
    for key in candidate_keys:
        if key in row:
            raw_value = row[key]
            text_value = str(raw_value).strip()
            if text_value:
                return text_value
    return ""


# ======================
# TMDB POSTER LOOKUP
# ======================
def get_tmdb_poster_url(movie_title: str, movie_year: str) -> str | None:
    """
    Look up a poster URL using TMDb and cache results in `tmdb_poster_cache`.

    Returns:
    - Poster URL string (TMDb w500)
    - None if no TMDb key is configured or no poster was found
    """
    if not TMDB_API_KEY:
        return None

    cleaned_title = (movie_title or "").strip()
    cleaned_year = (movie_year or "").strip()
    if not cleaned_title:
        return None

    cache_key = (cleaned_title.lower(), cleaned_year)
    if cache_key in tmdb_poster_cache:
        return tmdb_poster_cache[cache_key]

    query_params: dict[str, str] = {
        "api_key": TMDB_API_KEY,
        "query": cleaned_title,
        "include_adult": "false",
    }
    if cleaned_year.isdigit():
        query_params["year"] = cleaned_year

    try:
        response = requests.get(
            "https://api.themoviedb.org/3/search/movie",
            params=query_params,
            timeout=8,
        )
        response.raise_for_status()
        payload = response.json()

        results = payload.get("results")
        if not isinstance(results, list) or not results:
            tmdb_poster_cache[cache_key] = None
            return None

        first_match = results[0]
        if not isinstance(first_match, dict):
            tmdb_poster_cache[cache_key] = None
            return None

        poster_path = first_match.get("poster_path")
        if not poster_path:
            tmdb_poster_cache[cache_key] = None
            return None

        poster_url = f"https://image.tmdb.org/t/p/w500{poster_path}"
        tmdb_poster_cache[cache_key] = poster_url
        return poster_url
    except Exception as tmdb_error:
        print(
            f"[TMDb] Poster lookup failed for '{cleaned_title}' ({cleaned_year}): {tmdb_error}",
            flush=True,
        )
        tmdb_poster_cache[cache_key] = None
        return None


# ======================
# GEMINI RECOMMENDATIONS
# ======================
def parse_gemini_recommendations(
    gemini_text: str,
    maximum_movies_to_parse: int,
) -> list[dict[str, str]]:
    """
    Parse Gemini response into movie dictionaries.

    Expected format (repeated, separated by '#'):
    Title: ...
    Year: ...
    Director: ...
    why it fits: ...
    """
    if not gemini_text:
        return []
    if isinstance(gemini_text, str) and "Error:" in gemini_text:
        return []

    cleaned_text = gemini_text.strip()
    if cleaned_text.startswith("```"):
        cleaned_text = cleaned_text.split("```", 2)[-1].strip()

    raw_blocks = cleaned_text.split("#")
    blocks: list[str] = []
    for block in raw_blocks:
        trimmed_block = block.strip()
        if trimmed_block:
            blocks.append(trimmed_block)

    parsed_movies: list[dict[str, str]] = []
    for block in blocks[:maximum_movies_to_parse]:
        movie_title = ""
        movie_year = ""
        movie_director = ""
        why_it_fits = ""

        for raw_line in block.splitlines():
            line = raw_line.strip()
            lower_line = line.lower()

            if lower_line.startswith("title:"):
                movie_title = line.split(":", 1)[1].strip()
                continue
            if lower_line.startswith("year:"):
                movie_year = line.split(":", 1)[1].strip()
                continue
            if lower_line.startswith("director:"):
                movie_director = line.split(":", 1)[1].strip()
                continue
            if "why it fits" in lower_line and ":" in line:
                why_it_fits = line.split(":", 1)[1].strip()
                continue

        if movie_title:
            parsed_movies.append(
                {
                    "title": movie_title,
                    "year": movie_year,
                    "director": movie_director,
                    "why_it_fits": why_it_fits,
                }
            )

    return parsed_movies


def build_gemini_context_lines_from_watchlist() -> list[str]:
    """
    Build a "watched list" for Gemini from the user's clicked watchlist.
    This is used only if the user has not uploaded a CSV yet.
    """
    context_lines: list[str] = []
    for movie in watchlist_movies:
        title_value = str(movie.get("title", "")).strip()
        year_value = str(movie.get("year", "")).strip()
        if not title_value:
            continue
        if year_value:
            context_lines.append(f"{title_value} ({year_value})")
        else:
            context_lines.append(title_value)
    return context_lines


def get_best_available_gemini_context_lines() -> list[str]:
    """
    Choose the best available Gemini context.

    Priority:
    1) The latest uploaded CSV watch history (best signal)
    2) The user's clicked watchlist (fallback)
    """
    if _last_uploaded_watched_movies_lines:
        return list(_last_uploaded_watched_movies_lines)
    return build_gemini_context_lines_from_watchlist()


def request_movies_from_gemini(context_lines: list[str]) -> list[dict[str, str]]:
    """
    Call Gemini and parse recommendations.
    """
    if gemini_ask_recommendations is None and gemini_ask_question is None:
        print("[Gemini] Gemini client not available. Check GEMINI_API_KEY and dependencies.", flush=True)
        return []

    if not context_lines:
        print("[Gemini] No context lines available for recommendations.", flush=True)
        return []

    # Backward-compatible default is 3.
    raw_text = gemini_ask_question(context_lines) if gemini_ask_question else ""
    parsed = parse_gemini_recommendations(raw_text, maximum_movies_to_parse=3)
    if not parsed:
        snippet = str(raw_text)[:400]
        print(f"[Gemini] Parsed 0 movies. Raw snippet:\n{snippet}", flush=True)
    return parsed


def request_movies_from_gemini_v2(
    context_lines: list[str],
    *,
    count: int,
    liked_titles: list[str] | None = None,
    exclude_movies: list[str] | None = None,
) -> list[dict[str, str]]:
    """
    Call Gemini and parse up to `count` recommendations, with optional taste + exclusion context.
    """
    if gemini_ask_recommendations is None:
        # Fallback to legacy behavior (3 only)
        return request_movies_from_gemini(context_lines)

    if not context_lines:
        print("[Gemini] No context lines available for recommendations.", flush=True)
        return []

    safe_count = int(count) if isinstance(count, int) or str(count).isdigit() else 40
    safe_count = max(1, min(safe_count, 60))

    cleaned_liked = [str(t).strip() for t in (liked_titles or []) if str(t).strip()]
    cleaned_exclude = [str(t).strip() for t in (exclude_movies or []) if str(t).strip()]

    raw_text = gemini_ask_recommendations(
        context_lines,
        count=safe_count,
        liked_movies=cleaned_liked,
        exclude_movies=cleaned_exclude,
    )
    parsed = parse_gemini_recommendations(raw_text, maximum_movies_to_parse=safe_count)
    if not parsed:
        snippet = str(raw_text)[:400]
        print(f"[Gemini] Parsed 0 movies. Raw snippet:\n{snippet}", flush=True)
    return parsed


# ======================
# WATCHLIST MANAGEMENT
# ======================
def find_movie_in_current_recommendations(title: str) -> dict[str, Any] | None:
    """
    Find a movie dict in `current_recommendations` by its title.
    """
    normalized_clicked_title = normalize_movie_title(title)
    if not normalized_clicked_title:
        return None

    for movie in current_recommendations:
        current_title = str(movie.get("title", ""))
        if normalize_movie_title(current_title) == normalized_clicked_title:
            return movie

    return None


def add_movie_to_watchlist(movie: dict[str, Any]) -> None:
    """
    Add a movie to `watchlist_movies` if it is not already present.
    """
    movie_title = str(movie.get("title", "")).strip()
    if not movie_title:
        return

    normalized_title = normalize_movie_title(movie_title)
    for existing in watchlist_movies:
        existing_title = str(existing.get("title", ""))
        if normalize_movie_title(existing_title) == normalized_title:
            return

    watchlist_movies.append(
        {
            "title": movie_title,
            "director": str(movie.get("director", "")).strip(),
            "year": str(movie.get("year", "")).strip(),
            "image": str(movie.get("image", "")).strip(),
        }
    )


# ======================
# RECOMMENDATION REPLACEMENT
# ======================
def choose_one_new_movie_candidate(
    gemini_movies: list[dict[str, str]],
    excluded_titles: set[str],
) -> dict[str, str] | None:
    """
    Choose the first Gemini recommendation that is not excluded.
    """
    for movie in gemini_movies:
        title_value = str(movie.get("title", "")).strip()
        if not title_value:
            continue
        if normalize_movie_title(title_value) in excluded_titles:
            continue
        return movie
    return None


def replace_clicked_movie_with_new_recommendation(clicked_title: str) -> None:
    """
    Replace exactly one movie inside `current_recommendations` after a click.

    Steps:
    - Find the clicked movie index in `current_recommendations`
    - Call Gemini for recommendations
    - Pick ONE new movie not already shown / watchlisted
    - Fetch its TMDb poster
    - Replace only the clicked movie entry
    """
    normalized_clicked_title = normalize_movie_title(clicked_title)
    if not normalized_clicked_title:
        return

    clicked_index: int | None = None
    for index, movie in enumerate(current_recommendations):
        current_title = str(movie.get("title", ""))
        if normalize_movie_title(current_title) == normalized_clicked_title:
            clicked_index = index
            break

    if clicked_index is None:
        return

    excluded_titles: set[str] = set()
    for movie in current_recommendations:
        excluded_titles.add(normalize_movie_title(str(movie.get("title", ""))))
    for movie in watchlist_movies:
        excluded_titles.add(normalize_movie_title(str(movie.get("title", ""))))

    context_lines = get_best_available_gemini_context_lines()
    gemini_movies = request_movies_from_gemini(context_lines)
    chosen = choose_one_new_movie_candidate(gemini_movies, excluded_titles)
    if chosen is None:
        print("[Replace] Gemini did not return a usable new movie to replace.", flush=True)
        return

    new_title = str(chosen.get("title", "")).strip()
    new_year = str(chosen.get("year", "")).strip()
    new_director = str(chosen.get("director", "")).strip()

    poster_url = get_tmdb_poster_url(new_title, new_year) or "logo.svg"

    current_recommendations[clicked_index] = {
        "title": new_title,
        "director": new_director,
        "year": new_year,
        "image": poster_url,
    }


def refresh_all_recommendations() -> None:
    """
    Refresh all recommendations by calling Gemini and replacing `current_recommendations`.
    """
    context_lines = get_best_available_gemini_context_lines()
    gemini_movies = request_movies_from_gemini(context_lines)

    refreshed_movies: list[dict[str, Any]] = []
    for movie in gemini_movies[:3]:
        title_value = str(movie.get("title", "")).strip()
        year_value = str(movie.get("year", "")).strip()
        director_value = str(movie.get("director", "")).strip()
        if not title_value:
            continue
        poster_url = get_tmdb_poster_url(title_value, year_value) or "logo.svg"
        refreshed_movies.append(
            {
                "title": title_value,
                "director": director_value,
                "year": year_value,
                "image": poster_url,
            }
        )

    # Keep exactly 3 if possible; otherwise keep what we have.
    current_recommendations.clear()
    current_recommendations.extend(refreshed_movies[:3])


# ======================
# CSV UPLOAD (INITIALIZE RECOMMENDATIONS)
# ======================
def parse_uploaded_csv_rows(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    """
    Convert CSV DictReader rows into a normalized list of watched movies.
    """
    parsed_movies: list[dict[str, str]] = []

    for row in rows:
        movie_name = get_first_non_empty_value(row, ["Name", "name", "Movie", "movie", "Title", "title"])
        movie_year = get_first_non_empty_value(row, ["Year", "year"])
        movie_rating = get_first_non_empty_value(row, ["Rating", "rating", "Stars", "stars", "Score", "score"])
        watched_date = get_first_non_empty_value(row, ["Date", "date"])
        letterboxd_uri = get_first_non_empty_value(row, ["Letterboxd URI", "letterboxd_uri"])

        parsed_movies.append(
            {
                "date": watched_date,
                "name": movie_name,
                "year": movie_year,
                "rating": movie_rating,
                "letterboxd_uri": letterboxd_uri,
            }
        )

    return parsed_movies


def build_watched_lines_for_gemini(parsed_movies: list[dict[str, str]]) -> list[str]:
    """
    Build the watched list as lines like: "Movie Title (Year)".
    """
    watched_lines: list[str] = []
    for movie in parsed_movies:
        name_value = str(movie.get("name", "")).strip()
        year_value = str(movie.get("year", "")).strip()
        if not name_value:
            continue
        if year_value:
            watched_lines.append(f"{name_value} ({year_value})")
        else:
            watched_lines.append(name_value)
    return watched_lines


def _safe_float_or_none(value: str) -> float | None:
    try:
        s = str(value or "").strip()
        if not s:
            return None
        return float(s)
    except Exception:
        return None


@app.route("/upload", methods=["POST"])
def upload_csv():
    """
    Accept a CSV upload, parse it, call Gemini, and initialize `current_recommendations`.
    """
    print("\n========== CSV UPLOAD RECEIVED ==========", flush=True)

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    uploaded_file = request.files["file"]
    filename = str(uploaded_file.filename or "").strip()
    if not filename:
        return jsonify({"error": "No file selected"}), 400

    if not filename.lower().endswith(".csv"):
        return jsonify({"error": "File must be a CSV"}), 400

    try:
        decoded_text = uploaded_file.stream.read().decode("UTF-8", errors="replace")
        csv_stream = io.StringIO(decoded_text, newline=None)
        reader = csv.DictReader(csv_stream)
        rows = list(reader)
    except Exception as parse_error:
        return jsonify({"error": f"Failed to parse CSV: {parse_error}"}), 500

    if not rows:
        return jsonify({"error": "No rows found in CSV"}), 400

    parsed_movies = parse_uploaded_csv_rows(rows)
    watched_lines = build_watched_lines_for_gemini(parsed_movies)
    if not watched_lines:
        return jsonify({"error": "No movie titles found in CSV (expected columns like Name/Title/Movie)"}), 400

    _last_uploaded_watched_movies_lines.clear()
    _last_uploaded_watched_movies_lines.extend(watched_lines)

    # Store structured watchlist for local recommendation engine
    _last_uploaded_watched_movies.clear()
    _last_uploaded_watched_movies.extend(parsed_movies)

    _last_uploaded_watched_rating_by_key.clear()
    for m in parsed_movies:
        name_value = str(m.get("name", "")).strip()
        year_value = str(m.get("year", "")).strip()
        rating_value = _safe_float_or_none(str(m.get("rating", "")).strip())
        if not name_value:
            continue
        _last_uploaded_watched_rating_by_key[(normalize_movie_title(name_value) + "::" + year_value)] = rating_value

    # The recommendations page now generates batches from the local Top-250 database.
    # We intentionally do NOT call Gemini here.
    current_recommendations.clear()

    print(f"[Upload] Parsed {len(rows)} rows. CSV context ready.", flush=True)
    print("========== UPLOAD COMPLETE ==========\n", flush=True)

    return jsonify(
        {
            "message": "CSV uploaded and parsed successfully",
            "rows": len(rows),
            "csv_uploaded": True,
        }
    ), 200


# ======================
# API ROUTES
# ======================
@app.route("/api/recommendations", methods=["GET"])
def api_get_recommendations():
    """
    Return the currently displayed recommendations.
    """
    return jsonify({"movies": list(current_recommendations)}), 200


@app.route("/api/click", methods=["POST"])
def api_click_movie():
    """
    Backward-compatible endpoint. In the new UI, we do NOT replace recommendations
    server-side per click (the browser maintains a 40-movie queue).
    """
    global total_movie_click_count

    request_json = request.get_json(silent=True)
    if not isinstance(request_json, dict):
        return jsonify({"success": False, "error": "Invalid JSON body"}), 400

    clicked_title = str(request_json.get("title", "")).strip()
    clicked_year = str(request_json.get("year", "")).strip()
    clicked_director = str(request_json.get("director", "")).strip()
    clicked_image = str(request_json.get("image", "")).strip()

    if not clicked_title:
        return jsonify({"success": False, "error": "Missing 'title'"}), 400

    add_movie_to_watchlist(
        {
            "title": clicked_title,
            "year": clicked_year,
            "director": clicked_director,
            "image": clicked_image,
        }
    )

    total_movie_click_count += 1

    return jsonify(
        {
            "success": True,
            "total_clicks": total_movie_click_count,
        }
    ), 200


@app.route("/api/like", methods=["POST"])
def api_like_movie():
    """
    Record a 'like' interaction.

    - Adds the movie to watchlist (no duplicates)
    - Increments the global click/like counter
    - Does NOT fetch/replace recommendations (frontend queue handles that)
    """
    global total_movie_click_count

    request_json = request.get_json(silent=True)
    if not isinstance(request_json, dict):
        return jsonify({"success": False, "error": "Invalid JSON body"}), 400

    title = str(request_json.get("title", "")).strip()
    if not title:
        return jsonify({"success": False, "error": "Missing 'title'"}), 400

    year = str(request_json.get("year", "")).strip()
    director = str(request_json.get("director", "")).strip()
    image = str(request_json.get("image", "")).strip()

    add_movie_to_watchlist({"title": title, "year": year, "director": director, "image": image})
    total_movie_click_count += 1

    return jsonify({"success": True, "total_clicks": total_movie_click_count}), 200


def _movie_key(title: str, year: str) -> str:
    return f"{normalize_movie_title(title)}::{(year or '').strip()}"


@app.route("/api/batch", methods=["POST"])
def api_get_recommendation_batch():
    """
    Return a batch of recommendations.

    Request JSON:
    - mode: "regular" | "super" (default "regular")
    - liked_titles: list[str] (taste context for the next batch)
    - exclude_keys: list[str] of "normalizedTitle::year" already shown in this session
    - preferredActors: list[str] (optional; regular only)
    - preferredDirectors: list[str] (optional; regular only)

    Notes:
    - Regular mode: local recommender only (80 picks), no Gemini.
    - Super mode: Gemini-only recommendations (50 picks) + mapping profiles.
    """
    request_json = request.get_json(silent=True) or {}
    if not isinstance(request_json, dict):
        return jsonify({"error": "Invalid JSON body"}), 400

    mode = str(request_json.get("mode", "regular") or "regular").strip().lower()
    if mode not in ("regular", "super"):
        mode = "regular"

    liked_titles_raw = request_json.get("liked_titles", [])
    liked_titles: list[str] = []
    if isinstance(liked_titles_raw, list):
        liked_titles = [str(t).strip() for t in liked_titles_raw if str(t).strip()]

    exclude_keys_raw = request_json.get("exclude_keys", [])
    exclude_keys: set[str] = set()
    if isinstance(exclude_keys_raw, list):
        for k in exclude_keys_raw:
            key = str(k).strip()
            if key:
                exclude_keys.add(key)

    if not _last_uploaded_watched_movies_lines:
        return jsonify({"error": "No CSV uploaded yet."}), 400

    # Build watched keys set from uploaded CSV
    watched_keys: set[str] = set()
    for m in _last_uploaded_watched_movies:
        name_value = str(m.get("name", "")).strip()
        year_value = str(m.get("year", "")).strip()
        if not name_value:
            continue
        watched_keys.add(_movie_key(name_value, year_value))

    preferred_actors_raw = request_json.get("preferredActors", [])
    preferred_directors_raw = request_json.get("preferredDirectors", [])
    preferred_actors = [str(a).strip() for a in preferred_actors_raw] if isinstance(preferred_actors_raw, list) else []
    preferred_directors = [str(d).strip() for d in preferred_directors_raw] if isinstance(preferred_directors_raw, list) else []

    if mode == "regular":
        # Regular: local Top-250 recommender only (no Gemini)
        batch_size = 80
        top250 = _get_top250_movies()
        top250_index = _get_top250_index()

        # Helper maps for title-only -> (first) key (used for liked context)
        title_to_key: dict[str, str] = {}
        for mv in top250:
            t = normalize_movie_title(getattr(mv, "title", ""))
            if t and t not in title_to_key:
                title_to_key[t] = _movie_key(getattr(mv, "title", ""), getattr(mv, "year", ""))

        liked_keys_context: set[str] = set()
        for t in liked_titles:
            nt = normalize_movie_title(t)
            k = title_to_key.get(nt)
            if k:
                liked_keys_context.add(k)

        movies = _recommend_batch(
            top250,
            watched_keys=watched_keys,
            exclude_keys=exclude_keys,
            liked_keys_context=liked_keys_context,
            watched_rating_by_key=_last_uploaded_watched_rating_by_key,
            mode="regular",
            batch_size=batch_size,
            preferred_actors=preferred_actors,
            preferred_directors=preferred_directors,
        )
        for m in movies:
            if not str(m.get("image", "")).strip() or str(m.get("image", "")).strip() == "logo.svg":
                m["image"] = "default_poster.svg"

        # If the local pool is exhausted (can't fill the target batch), fall back to Gemini.
        if len(movies) < batch_size and gemini_ask_regular_recommendations is not None:
            try:
                # Combine liked context: recent likes + persistent watchlist
                liked_watchlist = [str(w.get("title", "")).strip() for w in watchlist_movies if str(w.get("title", "")).strip()]
                liked_context = []
                seen_like = set()
                for t in (liked_titles + liked_watchlist)[:300]:
                    nt = normalize_movie_title(t)
                    if not nt or nt in seen_like:
                        continue
                    seen_like.add(nt)
                    liked_context.append(t)

                watched_lines = list(_last_uploaded_watched_movies_lines)[:500]
                exclude_titles = []
                for k in list(exclude_keys)[:700]:
                    title_norm = str(k.split("::", 1)[0]).strip()
                    if title_norm:
                        exclude_titles.append(title_norm)
                # Also exclude the local movies we already selected this batch
                for m in movies:
                    exclude_titles.append(str(m.get("title", "")).strip())

                need = batch_size - len(movies)
                picks = gemini_ask_regular_recommendations(
                    watched_lines=watched_lines,
                    liked_titles=liked_context,
                    exclude_titles=exclude_titles,
                    count=min(need + 25, 120),
                )
                extra: list[dict[str, Any]] = []
                for p in picks:
                    title_v = str(p.get("title", "")).strip()
                    year_v = str(p.get("year", "")).strip()
                    director_v = str(p.get("director", "")).strip()
                    why = str(p.get("why_it_fits", "")).strip()
                    if not title_v:
                        continue
                    key = _movie_key(title_v, year_v)
                    if key in watched_keys or key in exclude_keys:
                        continue
                    poster_url = get_tmdb_poster_url(title_v, year_v) or ""
                    image_url = poster_url if str(poster_url).strip().startswith("http") else "default_poster.svg"
                    extra.append({"title": title_v, "year": year_v, "director": director_v, "image": image_url, "why_it_fits": why})
                    if len(extra) >= need:
                        break
                if extra:
                    movies = movies + extra
            except Exception as gemini_error:
                print(f"[Gemini] Regular fallback failed: {gemini_error}", flush=True)

        return jsonify({"movies": movies[:batch_size], "batch_size": batch_size, "mode": mode}), 200

    # Super: Gemini-only recommendations (not constrained to Top-250)
    batch_size = 50
    if gemini_ask_super_recommendations is None:
        return jsonify({"error": "Gemini is not configured on the server."}), 500

    try:
        watched_lines = list(_last_uploaded_watched_movies_lines)[:450]
        # Send exclude titles as best-effort (exclude_keys are normalizedTitle::year)
        exclude_titles: list[str] = []
        for k in list(exclude_keys)[:400]:
            title_norm = str(k.split("::", 1)[0]).strip()
            if title_norm:
                exclude_titles.append(title_norm)
        # Combine liked context: recent likes + persistent watchlist
        liked_watchlist = [str(w.get("title", "")).strip() for w in watchlist_movies if str(w.get("title", "")).strip()]
        liked_context: list[str] = []
        seen_like: set[str] = set()
        for t in (liked_titles + liked_watchlist)[:350]:
            nt = normalize_movie_title(t)
            if not nt or nt in seen_like:
                continue
            seen_like.add(nt)
            liked_context.append(t)
        exclude_titles.extend(liked_context[:200])

        rec_obj = gemini_ask_super_recommendations(
            watched_lines=watched_lines,
            liked_titles=liked_context,
            exclude_titles=exclude_titles,
            count=50,
            profiles=None,
        )
        profiles_obj: dict[str, Any] = rec_obj.get("profiles", {}) if isinstance(rec_obj, dict) else {}
        if not isinstance(profiles_obj, dict):
            profiles_obj = {}
        picks = rec_obj.get("movies", []) if isinstance(rec_obj, dict) else []
        if not isinstance(picks, list):
            picks = []
    except Exception as gemini_error:
        print(f"[Gemini] Super batch failed: {gemini_error}", flush=True)
        return jsonify({"error": "Gemini failed to generate a valid batch. Please retry."}), 502

    out: list[dict[str, Any]] = []
    seen_resp: set[str] = set()
    for p in picks:
        if not isinstance(p, dict):
            continue
        title_v = str(p.get("title", "")).strip()
        year_v = str(p.get("year", "")).strip()
        director_v = str(p.get("director", "")).strip()
        why = str(p.get("why_it_fits", "")).strip()
        if not title_v:
            continue
        key = _movie_key(title_v, year_v)
        if key in watched_keys or key in exclude_keys:
            continue
        if key in seen_resp:
            continue
        seen_resp.add(key)

        poster_url = get_tmdb_poster_url(title_v, year_v) or ""
        image_url = poster_url if str(poster_url).strip().startswith("http") else "default_poster.svg"
        out.append({"title": title_v, "year": year_v, "director": director_v, "image": image_url, "why_it_fits": why})
        if len(out) >= batch_size:
            break

    return jsonify({"movies": out, "batch_size": batch_size, "mode": mode, "profiles": profiles_obj}), 200


@app.route("/api/refresh", methods=["POST"])
def api_refresh_recommendations():
    """
    Full refresh endpoint: replace all recommendations with 3 new movies.
    """
    refresh_all_recommendations()
    return jsonify({"success": True, "new_recommendations": list(current_recommendations)}), 200


@app.route("/api/click-count", methods=["GET"])
def api_get_click_count():
    """
    Return the total number of tracked clicks across the app lifetime.
    """
    return jsonify({"count": total_movie_click_count}), 200


@app.route("/api/watchlist", methods=["GET"])
def api_get_watchlist():
    """
    Return the user's clicked watchlist.
    """
    return jsonify(list(watchlist_movies)), 200


@app.route("/api/watchlist/remove", methods=["POST"])
def api_remove_watchlist_item():
    """
    Remove a movie from the watchlist.

    Request JSON:
    - key: "normalizedTitle::year" (year may be empty)
    """
    request_json = request.get_json(silent=True)
    if not isinstance(request_json, dict):
        return jsonify({"success": False, "error": "Invalid JSON body"}), 400

    raw_key = str(request_json.get("key", "")).strip()
    if not raw_key:
        return jsonify({"success": False, "error": "Missing 'key'"}), 400

    title_part, _, year_part = raw_key.partition("::")
    normalized_title = str(title_part or "").strip().lower()
    year_part = str(year_part or "").strip()
    if not normalized_title:
        return jsonify({"success": False, "error": "Invalid key"}), 400

    removed = False
    for i in range(len(watchlist_movies) - 1, -1, -1):
        m = watchlist_movies[i]
        t = normalize_movie_title(str(m.get("title", "")))
        y = str(m.get("year", "")).strip()
        if t != normalized_title:
            continue
        if year_part and y != year_part:
            continue
        watchlist_movies.pop(i)
        removed = True
        break

    return jsonify({"success": True, "removed": removed, "watchlist_size": len(watchlist_movies)}), 200


# ======================
# STATIC PAGES + HEALTH
# ======================
@app.route("/", methods=["GET"])
def index():
    """
    Serve the landing page.
    """
    return send_from_directory(_BASE_DIR, "index.html")


@app.route("/recommend.html", methods=["GET"])
def recommend_page():
    """
    Serve the recommendations page.
    """
    return send_from_directory(_BASE_DIR, "recommend.html")


@app.route("/coffee.html", methods=["GET"])
def coffee_page():
    """
    Serve the minimalist coffee page.
    """
    return send_from_directory(_BASE_DIR, "coffee.html")


@app.route("/api/status", methods=["GET"])
def api_status():
    """
    Health check endpoint used for debugging.
    """
    return jsonify({"status": "ok"}), 200


@app.route("/api/csv-status", methods=["GET"])
def api_csv_status():
    """
    Report whether a CSV watch-history has been uploaded for this server process.

    The frontend uses this to decide between:
    - placeholder demo cards (no CSV)
    - real recommendations (CSV uploaded)
    """
    csv_uploaded = bool(_last_uploaded_watched_movies_lines)
    return jsonify({"csv_uploaded": csv_uploaded, "watched_count": len(_last_uploaded_watched_movies_lines)}), 200


if __name__ == "__main__":
    debug = os.getenv("FLASK_DEBUG", "0").strip() == "1"
    host = os.getenv("HOST", "0.0.0.0").strip() or "0.0.0.0"
    port_text = os.getenv("PORT", "5000").strip() or "5000"
    app.run(debug=debug, host=host, port=int(port_text))