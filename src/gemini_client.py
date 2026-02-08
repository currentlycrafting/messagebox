from __future__ import annotations

import ast
import json
import os
import re
from typing import Any, Optional

from dotenv import load_dotenv

try:
    from google import genai
except Exception:
    genai = None


load_dotenv()

_client = None
_client_key = None


def _get_client():
    global _client, _client_key
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    if genai is None:
        raise RuntimeError("google-genai is not installed or failed to import")
    if _client is None or _client_key != api_key:
        _client = genai.Client(api_key=api_key)
        _client_key = api_key
    return _client


def _extract_json(text: str) -> Any:
    """
    Gemini sometimes wraps JSON in ``` fences. This strips them and parses JSON.
    """
    if not isinstance(text, str):
        raise ValueError("Gemini response is not a string")

    def strip_fences(s: str) -> str:
        cleaned = (s or "").strip()
        if cleaned.startswith("```"):
            # remove first and last fence
            cleaned = cleaned.strip("`").strip()
            # if there is a leading language tag, remove it
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()
        return cleaned

    def extract_json_substring(s: str) -> str:
        """
        If the model adds pre/post text, pull the first JSON object/array block.
        Uses a simple bracket-depth scan so huge outputs still work.
        """
        s = (s or "").strip()
        if not s:
            return s
        # Find first "{" or "[" whichever occurs first.
        candidates = [(s.find("{"), "{", "}"), (s.find("["), "[", "]")]
        candidates = [c for c in candidates if c[0] != -1]
        if not candidates:
            return s
        start, open_ch, close_ch = min(candidates, key=lambda t: t[0])
        depth = 0
        in_str = False
        esc = False
        quote = ""
        for i in range(start, len(s)):
            ch = s[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == quote:
                    in_str = False
                continue
            if ch in ("'", '"'):
                in_str = True
                quote = ch
                continue
            if ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    return s[start : i + 1]
        return s[start:]

    def repair_json_like(s: str) -> str:
        """
        Repair common model output issues:
        - JS-style comments
        - trailing commas
        - unquoted keys
        - single-quoted strings
        - Python literals True/False/None
        """
        s = (s or "").strip()
        # Remove JS comments
        s = re.sub(r"/\\*.*?\\*/", "", s, flags=re.S)
        s = re.sub(r"(^|\\s)//.*?$", "", s, flags=re.M)
        # Normalize Python literals
        s = re.sub(r"\\bTrue\\b", "true", s)
        s = re.sub(r"\\bFalse\\b", "false", s)
        s = re.sub(r"\\bNone\\b", "null", s)
        # Remove trailing commas
        s = re.sub(r",\\s*([}\\]])", r"\\1", s)
        # Quote unquoted keys: { foo: 1, bar_baz: 2 } -> { "foo": 1, "bar_baz": 2 }
        s = re.sub(r'([\\{,]\\s*)([A-Za-z_][A-Za-z0-9_]*)(\\s*):', r'\\1"\\2"\\3:', s)
        # Convert single-quoted strings -> double-quoted strings
        # Only touches balanced single quotes.
        def _sq_to_dq(m: re.Match) -> str:
            inner = m.group(1)
            inner = inner.replace('"', '\\"')
            return f'"{inner}"'

        s = re.sub(r"'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'", _sq_to_dq, s)
        return s

    cleaned = strip_fences(text)
    candidate = extract_json_substring(cleaned)

    # Try strict JSON first
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass

    # Try repairs + JSON again
    repaired = repair_json_like(candidate)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        # Last resort: try Python literal eval (after repairs) for dict/list outputs.
        # This can handle some edge cases that still aren't strict JSON.
        try:
            obj = ast.literal_eval(repaired)
            return obj
        except Exception as e:
            # Provide a compact debug hint (avoid dumping full model output).
            snippet = repaired[:5000]
            raise ValueError(f"Failed to parse model JSON. Snippet:\\n{snippet}") from e


def ask_profiles(
    *,
    watched_top250_lines: list[str],
    liked_titles: Optional[list[str]] = None,
) -> dict[str, Any]:
    """
    Super-mode helper call:
    Produce genre/actor/director profiles as JSON.
    """
    watched_block = "\n".join(watched_top250_lines[:320])
    liked_block = "\n".join((liked_titles or [])[:100])
    prompt = f"""
You are a movie taste profiling system.

The user has watched these movies (some may be missing year):
{watched_block}

They liked these recently:
{liked_block}

Return STRICT JSON (no extra text) with this shape:
{{
  "genreProfile": {{"Action": 0.9, "Drama": 0.8}},
  "actorProfile": {{"Actor Name": 0.7}},
  "directorProfile": {{"Director Name": 0.8}}
}}

Rules:
- Scores must be 0..1 floats.
- Keep top ~12 genres, top ~15 actors, top ~10 directors.
"""
    client = _get_client()
    resp = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)
    data = _extract_json(resp.text)
    if not isinstance(data, dict):
        raise ValueError("profiles JSON is not an object")
    return data


def ask_super_recommendations(
    *,
    watched_lines: list[str],
    liked_titles: Optional[list[str]] = None,
    exclude_titles: Optional[list[str]] = None,
    count: int,
    profiles: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """
    Super-mode recommendations (NOT constrained to a local database).

    Returns STRICT JSON:
    {
      "profiles": {...},
      "movies": [
        {"title":"...", "year":"1999", "director":"..."}
      ]
    }
    """
    safe_count = int(count) if isinstance(count, int) or str(count).isdigit() else 50
    safe_count = max(1, min(safe_count, 50))

    # Keep prompt + response small to avoid truncation.
    watched_block = "\n".join((watched_lines or [])[:260])
    liked_block = "\n".join((liked_titles or [])[:120])
    exclude_block = "\n".join((exclude_titles or [])[:220])

    prompt = f"""
You are a movie recommendation system.

Watched movies (do NOT recommend these):
{watched_block}

Recently liked (use as taste signal; do NOT repeat):
{liked_block}

Exclude titles (do NOT recommend; may be partial titles):
{exclude_block}

Task:
1) Build compact taste profiles from watched+liked:
   - genreProfile (top 10)
   - actorProfile (top 12)
   - directorProfile (top 10)
   Scores are floats 0..1.
2) Recommend mainstream, widely-available, highly-rated movies (prefer English/ASCII titles).

Return STRICT JSON ONLY (no extra text) with this exact shape:
{{
  "profiles": {{
    "genreProfile": {{"Action": 0.9}},
    "actorProfile": {{"Actor Name": 0.7}},
    "directorProfile": {{"Director Name": 0.8}}
  }},
  "movies": [
    {{"title":"Movie Title","year":"1999","director":"Director Name"}}
  ]
}}

Rules:
- Return exactly {safe_count} unique movies.
- Do NOT include anything watched/liked/excluded.
- Keep each movie object ONLY the 3 keys: title, year, director.
- year should be a 4-digit string when known; otherwise "".
"""

    client = _get_client()

    last_error: Exception | None = None
    for attempt in range(2):
        try:
            resp = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)
            data = _extract_json(resp.text)
            break
        except Exception as e:
            last_error = e
            if attempt == 0:
                # Retry once with an extra constraint to discourage non-JSON output.
                prompt = "IMPORTANT: Output MUST be valid JSON. Do not truncate.\n\n" + prompt
                continue
            raise
    else:
        raise last_error or RuntimeError("Gemini request failed")

    if not isinstance(data, dict):
        raise ValueError("super recommendations JSON is not an object")
    movies = data.get("movies", [])
    if not isinstance(movies, list):
        raise ValueError("super recommendations JSON missing 'movies' list")
    profiles_obj = data.get("profiles", {})
    if not isinstance(profiles_obj, dict):
        profiles_obj = {}

    # sanitize movies list
    out_movies: list[dict[str, Any]] = []
    for item in movies:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        year = str(item.get("year", "")).strip()
        director = str(item.get("director", "")).strip()
        if not title:
            continue
        out_movies.append(
            {
                "title": title,
                "year": year,
                "director": director,
            }
        )
        if len(out_movies) >= safe_count:
            break
    data["profiles"] = profiles_obj
    data["movies"] = out_movies
    return data


def ask_regular_recommendations(
    *,
    watched_lines: list[str],
    liked_titles: Optional[list[str]] = None,
    exclude_titles: Optional[list[str]] = None,
    count: int,
) -> list[dict[str, str]]:
    """
    Regular-mode fallback: Gemini suggestions when local Top-250 pool is exhausted.

    Returns STRICT JSON list:
    [
      {"title":"...", "year":"1999", "director":"...", "why_it_fits":"..."}
    ]
    """
    safe_count = int(count) if isinstance(count, int) or str(count).isdigit() else 40
    safe_count = max(1, min(safe_count, 120))

    watched_block = "\n".join((watched_lines or [])[:420])
    liked_block = "\n".join((liked_titles or [])[:160])
    exclude_block = "\n".join((exclude_titles or [])[:260])

    prompt = f"""
You are a movie recommendation system.

Watched (do NOT recommend these):
{watched_block}

Liked (use as taste signal; do NOT repeat):
{liked_block}

Exclude titles (do NOT recommend; may be partial titles):
{exclude_block}

Goal:
- Recommend mainstream, widely-available, highly-rated movies that are likely to have posters/metadata.
- Prefer English-language / ASCII-titled movies.
- Avoid obscure/niche picks.

Return STRICT JSON (no extra text) as a list with EXACTLY {safe_count} unique items:
[
  {{"title":"Movie Title","year":"1999","director":"Director Name","why_it_fits":"<= 12 words"}}
]

Rules:
- year should be a 4-digit string when known; otherwise "".
- Keep why_it_fits very short (<= 12 words).
"""
    client = _get_client()
    resp = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)
    data = _extract_json(resp.text)
    if not isinstance(data, list):
        raise ValueError("regular recommendations JSON is not a list")
    out: list[dict[str, str]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        year = str(item.get("year", "")).strip()
        director = str(item.get("director", "")).strip()
        why = str(item.get("why_it_fits", "")).strip()
        if not title:
            continue
        out.append({"title": title, "year": year, "director": director, "why_it_fits": why})
        if len(out) >= safe_count:
            break
    return out


def ask_top250_recommendations(
    *,
    movie_database_lines: list[str],
    exclude_lines: list[str],
    count: int,
    mode: str,
    profiles: Optional[dict[str, Any]] = None,
) -> list[dict[str, str]]:
    """
    Return a list of {title, year} objects, STRICT JSON, selecting ONLY from movie_database_lines.
    """
    safe_count = int(count) if isinstance(count, int) or str(count).isdigit() else 50
    safe_count = max(1, min(safe_count, 50))
    mode = "super" if str(mode).strip().lower() == "super" else "regular"

    db_block = "\n".join(movie_database_lines[:250])
    ex_block = "\n".join(exclude_lines[:250])
    profiles_block = json.dumps(profiles or {}, ensure_ascii=False)

    prompt = f"""
You are a movie recommendation agent.

You MUST ONLY recommend movies from this database list (each line is \"Title (Year)\"):
{db_block}

Do NOT recommend anything from this exclude list:
{ex_block}

Mode: {mode}
Taste profiles (may be empty): {profiles_block}

Return STRICT JSON (no extra text) with this shape:
[
  {{"title":"Movie Title","year":"1999","why_it_fits":"short reason"}}
]

Rules:
- Return exactly {safe_count} unique items.
- Each item must match a title+year from the database list.
- Keep why_it_fits very short (<= 12 words).
"""
    client = _get_client()
    resp = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)
    data = _extract_json(resp.text)
    if not isinstance(data, list):
        raise ValueError("recommendations JSON is not a list")
    out: list[dict[str, str]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        year = str(item.get("year", "")).strip()
        why = str(item.get("why_it_fits", "")).strip()
        if title and year:
            out.append({"title": title, "year": year, "why_it_fits": why})
        if len(out) >= safe_count:
            break
    return out


# Backward compatible functions (still used elsewhere)
def ask_recommendations(watched_movies: list[str], *, count: int = 3, liked_movies: Optional[list[str]] = None, exclude_movies: Optional[list[str]] = None) -> str:
    return "Error: legacy ask_recommendations disabled; use ask_top250_recommendations"


def ask_question(watched_movies) -> str:
    return ask_recommendations(watched_movies, count=3)