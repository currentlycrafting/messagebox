// ==================== MOVIE CARD HANDLING ====================
const cardsContainer = document.getElementById('cardsContainer');
const starAnimation = document.getElementById('starAnimation');
const carouselNav = document.querySelector('.carousel-nav');
const carouselPrev = document.querySelector('.carousel-prev');
const carouselNext = document.querySelector('.carousel-next');
const carouselDotsWrap = document.querySelector('.carousel-dots');
let currentCardIndex = 0;
let cardWrappers = [];

// Sample movies for fallback
const sample_movies = [
  { title: "The Dark Knight", director: "Christopher Nolan", year: "2008", image: "images/dark-knight.jpg" },
  { title: "Interstellar", director: "Christopher Nolan", year: "2014", image: "images/interstellar.jpg" },
  { title: "Oppenheimer", director: "Christopher Nolan", year: "2023", image: "images/oppenheimer.jpg" }
];

// Load movies from API or use fallback
async function loadMovies() {
  try {
    const response = await fetch('http://127.0.0.1:5000/api/recommendations');
    if (!response.ok) throw new Error('API not available');
    const data = await response.json();
    renderMovieCards(data.movies);
  } catch (error) {
    console.log('Using sample movies:', error);
    renderMovieCards(sample_movies);
  }
}

// Render movie cards dynamically
function renderMovieCards(movies) {
  cardsContainer.innerHTML = '';
  currentCardIndex = 0;
  
  movies.forEach(movie => {
    const cardWrapper = document.createElement('div');
    cardWrapper.className = 'card-wrapper';
    cardWrapper.dataset.title = movie.title;
    cardWrapper.dataset.director = movie.director;
    cardWrapper.dataset.year = movie.year;
    
    cardWrapper.innerHTML = `
      <div class="product-card">
        <div class="card-image">
          <img src="${movie.image}" alt="${movie.title} poster" onerror="this.style.display='none'">
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
    
    // Card click handler
    productCard.addEventListener('click', () => {
      if (!favoriteBtn.classList.contains('active')) {
        handleCardClick(movie, cardWrapper);
      }
      favoriteBtn.classList.toggle('active');
    });
    
    // Star button click handler
    favoriteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!favoriteBtn.classList.contains('active')) {
        handleCardClick(movie, cardWrapper);
      }
      favoriteBtn.classList.toggle('active');
    });
  });

  // Setup carousel (small aspect ratio)
  cardWrappers = Array.from(cardsContainer.querySelectorAll('.card-wrapper'));
  setupCarousel(cardWrappers.length);
}

let currentAnimatingCard = null;
let starAnimTimeoutId = null;

// Handle card/star click
function handleCardClick(movie, cardWrapper) {
  playStarAnimation(cardWrapper);
  trackMovieClick(movie);
}

// Play star burst animation
// - Clicking the same card again during the animation does nothing
// - Clicking a different card will play immediately (moves the overlay)
function playStarAnimation(cardWrapper) {
  if (!cardWrapper) return;

  // If this same card is already animating, don't restart/cut it off
  if (currentAnimatingCard === cardWrapper && starAnimation.classList.contains('active')) {
    return;
  }

  // If switching cards mid-animation, clean up the previous card state
  if (currentAnimatingCard && currentAnimatingCard !== cardWrapper) {
    currentAnimatingCard.classList.remove('card-clicked');
  }

  currentAnimatingCard = cardWrapper;

  const rect = cardWrapper.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  starAnimation.style.left = `${centerX}px`;
  starAnimation.style.top = `${centerY}px`;
  
  cardWrapper.classList.add('card-clicked');

  // Restart overlay animation cleanly
  if (starAnimTimeoutId) {
    clearTimeout(starAnimTimeoutId);
    starAnimTimeoutId = null;
  }
  starAnimation.classList.remove('active');
  void starAnimation.offsetWidth;
  starAnimation.classList.add('active');

  starAnimTimeoutId = setTimeout(() => {
    // Only clear if we haven't switched to another card meanwhile
    if (currentAnimatingCard === cardWrapper) {
      starAnimation.classList.remove('active');
      cardWrapper.classList.remove('card-clicked');
      currentAnimatingCard = null;
      starAnimTimeoutId = null;
    }
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

function isSmallScreenCarousel() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function scrollToCard(index) {
  if (!cardsContainer || !cardWrappers[index]) return;

  if (!isSmallScreenCarousel()) return; // larger layouts show all cards

  cardsContainer.scrollTo({
    top: cardWrappers[index].offsetTop,
    behavior: 'smooth'
  });
}

function updateCarouselUI() {
  if (!carouselDotsWrap) return;
  const dots = Array.from(carouselDotsWrap.querySelectorAll('.carousel-dot'));
  dots.forEach((dot, i) => dot.classList.toggle('active', i === currentCardIndex));
  if (carouselPrev) carouselPrev.disabled = currentCardIndex === 0;
  if (carouselNext) carouselNext.disabled = currentCardIndex === cardWrappers.length - 1;
}

function setupCarousel(total) {
  if (!carouselDotsWrap || !carouselPrev || !carouselNext) return;

  // build dots
  carouselDotsWrap.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('button');
    dot.className = `carousel-dot${i === 0 ? ' active' : ''}`;
    dot.type = 'button';
    dot.dataset.index = String(i);
    dot.addEventListener('click', () => {
      currentCardIndex = i;
      scrollToCard(currentCardIndex);
      updateCarouselUI();
    });
    carouselDotsWrap.appendChild(dot);
  }

  carouselPrev.onclick = () => {
    if (currentCardIndex > 0) {
      currentCardIndex--;
      scrollToCard(currentCardIndex);
      updateCarouselUI();
    }
  };

  carouselNext.onclick = () => {
    if (currentCardIndex < cardWrappers.length - 1) {
      currentCardIndex++;
      scrollToCard(currentCardIndex);
      updateCarouselUI();
    }
  };

  // Sync when user scrolls vertically (swipe)
  let t = null;
  cardsContainer.addEventListener('scroll', () => {
    if (!isSmallScreenCarousel()) return;
    window.clearTimeout(t);
    t = window.setTimeout(() => {
      const top = cardsContainer.scrollTop;
      let best = 0;
      let dist = Infinity;
      cardWrappers.forEach((cw, idx) => {
        const d = Math.abs(cw.offsetTop - top);
        if (d < dist) { dist = d; best = idx; }
      });
      if (best !== currentCardIndex) {
        currentCardIndex = best;
        updateCarouselUI();
      }
    }, 80);
  }, { passive: true });

  window.addEventListener('resize', () => {
    // keep centered layout on larger sizes
    if (!isSmallScreenCarousel()) currentCardIndex = 0;
    updateCarouselUI();
  });

  updateCarouselUI();
}

