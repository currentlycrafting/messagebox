from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import csv
import io
import os

import requests
from dotenv import load_dotenv

try:
    from gemini_client import ask_question as gemini_ask_question
except Exception:
    gemini_ask_question = None  # e.g. ImportError or ValueError (missing API key)

load_dotenv()

TMDB_API_KEY = os.getenv("TMDB_API_KEY")

app = Flask(__name__, template_folder='.', static_folder='.')
CORS(app)  # Enable CORS for frontend requests

# ==================== IN-MEMORY STORAGE ====================
# Store clicked movies for future Google Gemini API integration
clicked_movies = []

# Latest 3 recommendations from Gemini (parse_csv); recommend page fetches from /api/recommendations
latest_recommendations = []

# Sample movie data (will be replaced by API data later)
sample_movies = [
    {
        "title": "The Dark Knight",
        "director": "Christopher Nolan",
        "year": "2008",
        "image": "images/dark-knight.jpg"
    },
    {
        "title": "Interstellar",
        "director": "Christopher Nolan",
        "year": "2014",
        "image": "images/interstellar.jpg"
    },
    {
        "title": "Oppenheimer",
        "director": "Christopher Nolan",
        "year": "2023",
        "image": "images/oppenheimer.jpg"
    }
]

_tmdb_poster_cache = {}


def get_tmdb_poster_url(title: str, year: str | None = None) -> str | None:
    """
    Fetch poster URL from TMDb for a given title/year.
    Returns None if TMDb key missing or poster not found.
    """
    if not TMDB_API_KEY:
        return None

    t = (title or "").strip()
    y = (year or "").strip()
    if not t:
        return None

    cache_key = (t.lower(), y)
    if cache_key in _tmdb_poster_cache:
        return _tmdb_poster_cache[cache_key]

    params = {"api_key": TMDB_API_KEY, "query": t, "include_adult": "false"}
    if y.isdigit():
        params["year"] = y

    try:
        resp = requests.get("https://api.themoviedb.org/3/search/movie", params=params, timeout=8)
        resp.raise_for_status()
        data = resp.json()
        results = data.get("results") or []
        poster_path = results[0].get("poster_path") if results else None
        poster_url = f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else None
        _tmdb_poster_cache[cache_key] = poster_url
        return poster_url
    except Exception as e:
        print(f"[TMDb] Poster lookup failed for {t} ({y}): {e}", flush=True)
        _tmdb_poster_cache[cache_key] = None
        return None


# ==================== API TEMPLATE FUNCTIONS ====================
# These functions are placeholders for future API integration

def get_movie_data(movie_id):
    """
    Fetch movie metadata from external API.
    
    Future implementation will call actual movie database API.
    Returns: {title, director, year}
    
    Args:
        movie_id: Identifier for the movie (could be IMDB ID, TMDB ID, etc.)
    
    Returns:
        dict: Movie metadata including title, director, and year
    """
    # PLACEHOLDER - Replace with actual API call
    # Example API: TMDB, OMDB, or similar
    # response = requests.get(f"https://api.themoviedb.org/3/movie/{movie_id}")
    # return response.json()
    
    return {
        "title": "Movie Title",
        "director": "Director Name",
        "year": "2024"
    }


def get_movie_poster(movie_title):
    """
    Fetch movie poster image URL from external API.
    
    Future implementation will call actual poster API.
    
    Args:
        movie_title: Title of the movie to search for
    
    Returns:
        str: URL of the movie poster image
    """
    # PLACEHOLDER - Replace with actual API call
    # Example: TMDB poster API
    # response = requests.get(f"https://api.themoviedb.org/3/search/movie?query={movie_title}")
    # poster_path = response.json()['results'][0]['poster_path']
    # return f"https://image.tmdb.org/t/p/w500{poster_path}"
    
    return "images/placeholder.jpg"


def _parse_gemini_recommendations(text):
    """Parse Gemini response into list of dicts: title, year, director, why_it_fits."""
    if not text or (isinstance(text, str) and "Error:" in text):
        return []
    text = text.strip()
    # Normalize: sometimes Gemini wraps in markdown or uses different spacing
    if text.startswith("```"):
        text = text.split("```", 2)[-1].strip()
    recommendations = []
    blocks = [b.strip() for b in text.split("#") if b.strip()]
    # If no # delimiter, try splitting by "Title" line (one block per movie)
    if not blocks and "Title" in text:
        parts = text.replace("\r", "\n").split("\n")
        current = []
        for line in parts:
            line = line.strip()
            if line.lower().startswith("title") and ":" in line:
                if current and any("title" in l.lower() for l in current):
                    blocks.append("\n".join(current))
                current = [line]
            elif current:
                current.append(line)
        if current:
            blocks.append("\n".join(current))
    for block in blocks[:3]:
        movie = {}
        for line in block.split("\n"):
            line = line.strip()
            lower = line.lower()
            if lower.startswith("title") and ":" in line:
                movie["title"] = line.split(":", 1)[1].strip()
            elif lower.startswith("year") and ":" in line:
                movie["year"] = line.split(":", 1)[1].strip()
            elif lower.startswith("director") and ":" in line:
                movie["director"] = line.split(":", 1)[1].strip()
            elif "why it fits" in lower and ":" in line:
                movie["why_it_fits"] = line.split(":", 1)[1].strip()
        if movie.get("title"):
            recommendations.append(movie)
    return recommendations


def get_recommendations_from_gemini(user_movies):
    """
    Get 3 movie recommendations from Google Gemini API based on parsed CSV (watched) movies.
    user_movies: list of dicts with 'name' and 'year' (from CSV).
    Returns: list of up to 3 dicts with title, director, year, why_it_fits.
    """
    if not gemini_ask_question:
        print("[Recommendations] Gemini client not available (check .env / GEMINI_API_KEY)")
        return []
    watched = [f"{m.get('name', '')} ({m.get('year', '')})" for m in user_movies if (m.get("name") or "").strip()]
    if not watched:
        print("[Recommendations] No movie names in CSV (check column headers: Name/Movie/Title)")
        return []
    raw = gemini_ask_question(watched)
    if not raw or (isinstance(raw, str) and "Error:" in raw):
        print(f"[Recommendations] Gemini returned error or empty: {repr(raw)[:200]}")
        return []
    parsed = _parse_gemini_recommendations(raw)
    if not parsed and len(raw) > 50:
        print(f"[Recommendations] Parser got 0. Raw response (first 500 chars):\n{raw[:500]}")
    return parsed


# ==================== ROUTES ====================

@app.route('/upload', methods=['POST'])
def upload_file():
    """Handle CSV file upload and parse its contents"""
    print("\n========== CSV UPLOAD RECEIVED ==========", flush=True)

    # Check if file is present in request
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    
    # Check if filename is empty
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    # Validate file type
    if not file.filename.endswith('.csv'):
        return jsonify({'error': 'File must be a CSV'}), 400
    
    try:
        # Read file content as text
        stream = io.StringIO(file.stream.read().decode("UTF8"), newline=None)
        csv_reader = csv.DictReader(stream)
        return parse_csv(csv_reader)
    
    except Exception as e:
        return jsonify({'error': f'Failed to parse CSV: {str(e)}'}), 500


def parse_csv(raw_file):
    """Parse CSV file and return movie data"""
    rows = list(raw_file)
    if not rows:
        print("[Upload] No rows in CSV", flush=True)
        return jsonify({'error': "NO DATA IN CSV"}), 400

    print(f"[Upload] Parsing {len(rows)} rows...", flush=True)
    # Parse CSV data (support common column name variants)
    parsed_data = []
    for row in rows:
        name = (row.get('Name') or row.get('name') or row.get('Movie') or
                row.get('movie') or row.get('Title') or row.get('title') or '')
        year = (row.get('Year') or row.get('year') or '')
        parsed_data.append({
            'date': row.get('Date', '') or row.get('date', ''),
            'name': name.strip(),
            'year': str(year).strip() if year else '',
            'letterboxd_uri': row.get('Letterboxd URI', '') or row.get('letterboxd_uri', '')
        })

    # Get 3 recommended movies from Gemini (must be movies they haven't seen)
    try:
        recommendations = get_recommendations_from_gemini(parsed_data)
    except Exception as e:
        print(f"[Gemini error] {e}")
        recommendations = []

    # Filter out any recommendation that is in the user's watch list (safety check)
    watched_titles = {(m.get("name") or "").strip().lower() for m in parsed_data if (m.get("name") or "").strip()}
    if watched_titles:
        original_count = len(recommendations)
        recommendations = [m for m in recommendations if (m.get("title") or "").strip().lower() not in watched_titles]
        if len(recommendations) < original_count:
            print(f"[Recommendations] Filtered out {original_count - len(recommendations)} that were in watch list", flush=True)

    print(f"[Upload] Parsed {len(parsed_data)} rows, got {len(recommendations)} recommendations", flush=True)
    if not recommendations:
        with_names = sum(1 for m in parsed_data if (m.get('name') or '').strip())
        print(f"[Recommendations] Got 0. Rows: {len(parsed_data)}, with names: {with_names}, Gemini available: {gemini_ask_question is not None}", flush=True)
    if recommendations:
        print("\n--- 3 RECOMMENDED MOVIES ---", flush=True)
        for i, movie in enumerate(recommendations, 1):
            title = movie.get("title", "?")
            year = movie.get("year", "?")
            director = movie.get("director", "?")
            why = movie.get("why_it_fits", "")
            print(f"  {i}. {title} ({year}) – {director}", flush=True)
            if why:
                print(f"     Why: {why}", flush=True)
        print("-----------------------------\n", flush=True)

        # Format like sample_movies; store in latest_recommendations (for /api/recommendations) and append to clicked_movies
        global clicked_movies, latest_recommendations
        formatted = [
            {
                "title": m.get("title", ""),
                "director": m.get("director", ""),
                "year": str(m.get("year", "")),
                "image": get_tmdb_poster_url(m.get("title", ""), str(m.get("year", ""))) or "logo.svg"
            }
            for m in recommendations
        ]
        latest_recommendations = formatted
        for m in formatted:
            clicked_movies.append(m)

    print("========== UPLOAD COMPLETE ==========\n", flush=True)
    return jsonify({
        'message': 'CSV uploaded and parsed successfully',
        'rows': len(parsed_data),
        'data': parsed_data,
        'recommendations': recommendations
    }), 200


@app.route('/api/click', methods=['POST'])
def track_click():
    """
    Track when a user clicks on a movie card.
    Stores movie data for future Google Gemini API integration.
    """
    data = request.get_json()
    
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    
    # Extract movie info
    movie_info = {
        "title": data.get('title', ''),
        "director": data.get('director', ''),
        "year": data.get('year', '')
    }
    
    # Add to clicked movies list
    clicked_movies.append(movie_info)
    
    print(f"[CLICK TRACKED] {movie_info['title']} ({movie_info['year']}) - Director: {movie_info['director']}")
    print(f"[TOTAL CLICKS] {len(clicked_movies)} movies tracked")
    
    return jsonify({
        'success': True,
        'message': f"Tracked: {movie_info['title']}",
        'total_clicks': len(clicked_movies)
    }), 200


@app.route('/api/clicked-movies', methods=['GET'])
def get_clicked_movies():
    """Return all clicked movies (for debugging/future use)"""
    return jsonify({
        'clicked_movies': clicked_movies,
        'count': len(clicked_movies)
    }), 200


@app.route('/api/recommendations', methods=['GET'])
def get_recommendations():
    """Return latest 3 Gemini recommendations (from parse_csv). Recommend page fetches from here."""
    movies = [
        {**m, "image": m.get("image", "images/placeholder.jpg")}
        for m in latest_recommendations
    ]
    return jsonify({
        'movies': movies
    }), 200


@app.route('/api/movies', methods=['GET'])
def get_movies():
    """
    Return sample movie data (fallback when no recommendations yet).
    """
    return jsonify({
        'movies': sample_movies
    }), 200


@app.route('/', methods=['GET'])
def index():
    """ Serve the main index.html page """
    return render_template('index.html')
    # """Simple endpoint to check if server is running"""
    # return jsonify({'status': 'Flask server is running'}), 200


if __name__ == '__main__':
    pass
    # port = int(os.getenv('PORT', 10000))
    # app.run(debug=False, host='0.0.0.0', port=port)
