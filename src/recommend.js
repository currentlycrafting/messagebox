// ==================== DARK MODE ====================
const darkModeToggle = document.getElementById('darkModeToggle');
const moonIcon = document.querySelector('.moon-icon');
const sunIcon = document.querySelector('.sun-icon');

// Check for saved dark mode preference
if (localStorage.getItem('darkMode') === 'enabled') {
  document.body.classList.add('dark-mode');
  if (moonIcon) moonIcon.style.display = 'none';
  if (sunIcon) sunIcon.style.display = 'block';
}

if (darkModeToggle) {
  darkModeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    
    if (document.body.classList.contains('dark-mode')) {
      localStorage.setItem('darkMode', 'enabled');
      if (moonIcon) moonIcon.style.display = 'none';
      if (sunIcon) sunIcon.style.display = 'block';
    } else {
      localStorage.setItem('darkMode', 'disabled');
      if (moonIcon) moonIcon.style.display = 'block';
      if (sunIcon) sunIcon.style.display = 'none';
    }
  });
}

// ==================== MOVIE CARDS ====================
// ==================== MOVIE CARDS ====================
const cardsContainer = document.getElementById('cardsContainer');
const starAnimation = document.getElementById('starAnimation');

// Fetch movies from API and render cards (using second version logic)
async function loadMovies() {
  try {
    // Fetch from general movies API
    const response = await fetch('http://127.0.0.1:5000/api/movies');
    const data = await response.json();

    if (data.movies && data.movies.length > 0) {
      renderMovieCards(data.movies);
    } else {
      // No movies returned; show hardcoded fallback
      const fallbackMovies = [
        { title: "The Dark Knight", director: "Christopher Nolan", year: "2008", image: "images/dark-knight.jpg" },
        { title: "Interstellar", director: "Christopher Nolan", year: "2014", image: "images/interstellar.jpg" },
        { title: "Oppenheimer", director: "Christopher Nolan", year: "2023", image: "images/oppenheimer.jpg" }
      ];
      renderMovieCards(fallbackMovies);
    }
  } catch (error) {
    console.error('Error loading movies:', error);
    // Fetch failed; show hardcoded fallback
    const fallbackMovies = [
      { title: "The Dark Knight", director: "Christopher Nolan", year: "2008", image: "images/dark-knight.jpg" },
      { title: "Interstellar", director: "Christopher Nolan", year: "2014", image: "images/interstellar.jpg" },
      { title: "Oppenheimer", director: "Christopher Nolan", year: "2023", image: "images/oppenheimer.jpg" }
    ];
    renderMovieCards(fallbackMovies);
  }
}

// Render movie cards dynamically
function renderMovieCards(movies) {
  cardsContainer.innerHTML = '';
  
  movies.forEach((movie, index) => {
    const cardWrapper = document.createElement('div');
    cardWrapper.className = 'card-wrapper';
    cardWrapper.dataset.title = movie.title;
    cardWrapper.dataset.director = movie.director;
    cardWrapper.dataset.year = movie.year;
    
    cardWrapper.innerHTML = `
      <div class="product-card" data-index="${index}">
        <div class="card-image">
          <img src="${movie.image}" alt="${movie.title} poster" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
          <div class="placeholder-fallback" style="display: none;">
            <svg class="placeholder-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <circle cx="8.5" cy="8.5" r="1.5"></circle>
              <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
          </div>
        </div>
        <div class="card-body">
          <p class="card-title">Title: ${movie.title} (${movie.year})</p>
          <p class="card-subtitle">Director: ${movie.director}</p>
        </div>
      </div>
      <div class="card-action">
        <button class="icon-btn icon-btn-filled favorite-btn" aria-label="Add ${movie.title} to favorites">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
        </button>
      </div>
    `;
    
    cardsContainer.appendChild(cardWrapper);
    
    // Add click handlers
    const productCard = cardWrapper.querySelector('.product-card');
    const favoriteBtn = cardWrapper.querySelector('.favorite-btn');
    
    // Card click handler - also toggles the star button
    productCard.addEventListener('click', () => {
      // Only play animation if not already active
      if (!favoriteBtn.classList.contains('active')) {
        handleCardClick(movie, cardWrapper);
      }
      favoriteBtn.classList.toggle('active');
    });
    
    // Star button click handler
    favoriteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent triggering card click
      // Only play animation if not already active
      if (!favoriteBtn.classList.contains('active')) {
        handleCardClick(movie, cardWrapper);
      }
      favoriteBtn.classList.toggle('active');
    });
  });
}

// Handle card/star click - play animation and track
function handleCardClick(movie, cardWrapper) {
  // Play star burst animation
  playStarAnimation(cardWrapper);
  
  // Track click in backend
  trackMovieClick(movie);
}

// Play star burst animation
function playStarAnimation(cardWrapper) {
  // Get position of the card
  const rect = cardWrapper.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  // Position animation at card center
  starAnimation.style.left = `${centerX}px`;
  starAnimation.style.top = `${centerY}px`;
  
  // Remove active class first to reset animation
  starAnimation.classList.remove('active');
  
  // Force reflow to restart animation
  void starAnimation.offsetWidth;
  
  // Show and animate
  starAnimation.classList.add('active');
  
  // Add pulse effect to the card
  cardWrapper.classList.add('card-clicked');
  
  // Remove animation classes after animation completes
  setTimeout(() => {
    starAnimation.classList.remove('active');
    cardWrapper.classList.remove('card-clicked');
  }, 1000);
}

// Send click data to Flask backend
async function trackMovieClick(movie) {
  try {
    const response = await fetch('http://127.0.0.1:5000/api/click', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: movie.title,
        director: movie.director,
        year: movie.year
      })
    });
    
    const data = await response.json();
    console.log('Click tracked:', data);
  } catch (error) {
    console.error('Error tracking click:', error);
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  loadMovies();
});

