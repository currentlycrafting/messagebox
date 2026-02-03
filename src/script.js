// ==================== VIDEO BACKGROUND CONTROL ====================
const videoBackground = document.getElementById('videoBackground');
const heroVideo = document.getElementById('heroVideo');
const heroSection = document.querySelector('.hero-section');
const hoverHint = document.getElementById('hoverHint');
let videoStarted = false;

// YouTube Player API
let player;

// Load YouTube IFrame API
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

// Called automatically when YouTube API is ready
window.onYouTubeIframeAPIReady = function() {
  player = new YT.Player('heroVideo', {
    events: {
      'onReady': onPlayerReady
    }
  });
};

function onPlayerReady(event) {
  console.log('YouTube player ready');
}

// Start video on hover (toggle on - stays playing)
heroSection.addEventListener('mouseenter', () => {
  if (!videoStarted && player && player.playVideo) {
    player.playVideo();
    videoBackground.classList.add('playing');
    videoStarted = true;
    
    if (hoverHint) {
      hoverHint.classList.add('hidden');
    }
  }
});

// ==================== FILE UPLOAD ====================
const dropArea = document.getElementById("fileUpload");
const statusText = document.getElementById("statusText");
const snapContainer = document.querySelector('.snap-container');

function setStatus(message, type = "") {
  if (!statusText) return;
  statusText.textContent = message;
  statusText.className = "status-text";
  if (type) {
    statusText.classList.add(type);
  }
}

dropArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropArea.classList.add("drag-over");
});

dropArea.addEventListener("dragleave", () => {
  dropArea.classList.remove("drag-over");
});

dropArea.addEventListener("drop", (e) => {
  e.preventDefault();
  dropArea.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) {
    handleFile(file);
  }
});

dropArea.addEventListener("click", () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      handleFile(file);
    }
  };
  input.click();
});

function handleFile(file) {
  if (file.type !== "text/csv" && !file.name.endsWith(".csv")) {
    setStatus("Invalid file format. Please upload a CSV file.", "error");
    return;
  }

  setStatus("Analyzing your movies...", "loading");
  dropArea.disabled = true;

  setTimeout(() => {
    const formData = new FormData();
    formData.append("file", file);

    fetch("http://127.0.0.1:5000/upload", {
      method: "POST",
      body: formData
    })
    .then(response => {
      if (!response.ok) {
        throw new Error('Server error');
      }
      return response.json();
    })
    .then(data => {
      console.log(data);
      setStatus(`Recommendations ready! Found ${data.rows} movies.`, "success");
      
      setTimeout(() => {
        window.location.href = 'recommend.html';
      }, 1500);
    })
    .catch(error => {
      console.error("Error:", error);
      setStatus("Failed to process file. Please try again.", "error");
    })
    .finally(() => {
      dropArea.disabled = false;
    });
  }, 5000);
}

// ==================== KEYBOARD NAVIGATION ====================
document.addEventListener('keydown', (e) => {
  const sections = document.querySelectorAll('.section');
  const currentScroll = snapContainer.scrollTop;
  const sectionHeight = window.innerHeight;
  
  if (e.key === 'ArrowDown' || e.key === 'PageDown') {
    e.preventDefault();
    const nextSection = Math.min(
      Math.floor(currentScroll / sectionHeight) + 1,
      sections.length - 1
    );
    snapContainer.scrollTo({
      top: nextSection * sectionHeight,
      behavior: 'smooth'
    });
  }
  
  if (e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault();
    const prevSection = Math.max(
      Math.ceil(currentScroll / sectionHeight) - 1,
      0
    );
    snapContainer.scrollTo({
      top: prevSection * sectionHeight,
      behavior: 'smooth'
    });
  }
});

// ==================== CARD CLICK HANDLING ====================
const starAnimation = document.getElementById('starAnimation');
const cardWrappers = document.querySelectorAll('.card-wrapper');
let currentAnimatingCard = null;
let starAnimTimeoutId = null;

// Play star burst animation
// - Clicking the same card again during the animation does nothing
// - Clicking a different card will play immediately (moves the overlay)
function playStarAnimation(cardWrapper) {
  if (!starAnimation || !cardWrapper) return;

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

  // Restart overlay animation cleanly
  if (starAnimTimeoutId) {
    clearTimeout(starAnimTimeoutId);
    starAnimTimeoutId = null;
  }
  starAnimation.classList.remove('active');
  // force reflow so CSS animation restarts reliably
  void starAnimation.offsetWidth;
  starAnimation.classList.add('active');

  cardWrapper.classList.add('card-clicked');

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
      body: JSON.stringify(movie)
    });
    
    const data = await response.json();
    console.log('Click tracked:', data);
  } catch (error) {
    console.error('Error tracking click:', error);
  }
}

// Handle card click
function handleCardClick(cardWrapper) {
  const movie = {
    title: cardWrapper.dataset.title || '',
    director: cardWrapper.dataset.director || '',
    year: cardWrapper.dataset.year || ''
  };
  
  playStarAnimation(cardWrapper);
  
  if (movie.title) {
    trackMovieClick(movie);
  }
}

// Add click handlers to all card wrappers
cardWrappers.forEach(wrapper => {
  const productCard = wrapper.querySelector('.product-card');
  const favoriteBtn = wrapper.querySelector('.favorite-btn');
  
  if (productCard) {
    productCard.addEventListener('click', () => {
      if (favoriteBtn) {
        if (!favoriteBtn.classList.contains('active')) {
          handleCardClick(wrapper);
        }
        favoriteBtn.classList.toggle('active');
      }
    });
  }
  
  if (favoriteBtn) {
    favoriteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!favoriteBtn.classList.contains('active')) {
        handleCardClick(wrapper);
      }
      favoriteBtn.classList.toggle('active');
    });
  }
});

// ==================== CAROUSEL FUNCTIONALITY ====================
const cardsContainer = document.querySelector('.cards-container');
const carouselPrev = document.querySelector('.carousel-prev');
const carouselNext = document.querySelector('.carousel-next');
const carouselDots = document.querySelectorAll('.carousel-dot');
let currentCardIndex = 0;
const totalCards = cardWrappers.length;

function updateCarousel() {
  // Move all cards
  cardWrappers.forEach((card, index) => {
    card.style.transform = `translateX(-${currentCardIndex * 100}%)`;
  });
  
  // Update dots
  carouselDots.forEach((dot, index) => {
    dot.classList.toggle('active', index === currentCardIndex);
  });
  
  // Update arrow states
  if (carouselPrev) {
    carouselPrev.disabled = currentCardIndex === 0;
  }
  if (carouselNext) {
    carouselNext.disabled = currentCardIndex === totalCards - 1;
  }
}

if (carouselPrev) {
  carouselPrev.addEventListener('click', () => {
    if (currentCardIndex > 0) {
      currentCardIndex--;
      updateCarousel();
    }
  });
}

if (carouselNext) {
  carouselNext.addEventListener('click', () => {
    if (currentCardIndex < totalCards - 1) {
      currentCardIndex++;
      updateCarousel();
    }
  });
}

carouselDots.forEach((dot, index) => {
  dot.addEventListener('click', () => {
    currentCardIndex = index;
    updateCarousel();
  });
});

// ==================== SCROLL INDICATORS ====================
const scrollIndicators = document.querySelectorAll('.scroll-indicator');
scrollIndicators.forEach((indicator, index) => {
  indicator.addEventListener('click', () => {
    const targetSection = (index + 1) * window.innerHeight;
    snapContainer.scrollTo({
      top: targetSection,
      behavior: 'smooth'
    });
  });
  indicator.style.cursor = 'pointer';
});

// ==================== BACK TO TOP ====================
const backToTop = document.getElementById('backToTop');
if (backToTop) {
  backToTop.addEventListener('click', () => {
    snapContainer.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  });
}

