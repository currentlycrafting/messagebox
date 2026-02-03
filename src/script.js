// JavaScript to handle drag & drop, file upload, and scroll snapping
const dropArea = document.getElementById('fileUpload');
const statusText = document.getElementById('statusText');
const snapContainer = document.querySelector('.snap-container');

// Helper function to update status
function setStatus(message, type = '') {
  statusText.textContent = message;
  statusText.className = 'status-text';
  if (type) {
    statusText.classList.add(type);
  }
}

// Highlight when dragging (cosmetic only)
dropArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropArea.classList.add('drag-over');
});

// Remove highlight when not dragging
dropArea.addEventListener('dragleave', () => {
  dropArea.classList.remove('drag-over');
});

// Handle dropped files
dropArea.addEventListener('drop', (e) => {
  e.preventDefault();
  dropArea.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

// Handle click to open file picker
dropArea.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.onchange = (e) => {
    handleFile(e.target.files[0]);
  };
  input.click();
});

// Handle Enter key for accessibility
dropArea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    dropArea.click();
  }
});

// Main file handling function
function handleFile(file) {
  if (!file) return;

  // Validate CSV (checks both type and extension for browser compatibility)
  if (file.type !== "text/csv" && !file.name.endsWith(".csv")) {
    setStatus("❌ Invalid file format. Please upload a CSV file.", "error");
    return;
  }

  // Show loading state
  setStatus("⏳ Analyzing your movies...", "loading");
  dropArea.disabled = true;

  // Send CSV to Python backend
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
    setStatus(`✅ Recommendations ready! Found ${data.rows} movies.`, "success");
    
    // Redirect to recommendations page after short delay
    setTimeout(() => {
      window.location.href = 'recommend.html';
    }, 1500);
  })
  .catch(error => {
    console.error("Error:", error);
    setStatus("❌ Failed to process file. Please try again.", "error");
  })
  .finally(() => {
    dropArea.disabled = false;
  });
}

// Keyboard navigation for scroll snapping
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

// Play star burst animation
function playStarAnimation(element) {
  if (!starAnimation) return;
  
  // Get position of the element
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  // Position animation at element center
  starAnimation.style.left = `${centerX}px`;
  starAnimation.style.top = `${centerY}px`;
  
  // Remove active class first to reset animation
  starAnimation.classList.remove('active');
  
  // Force reflow to restart animation
  void starAnimation.offsetWidth;
  
  // Show and animate
  starAnimation.classList.add('active');
  
  // Add pulse effect to the card wrapper
  const cardWrapper = element.closest('.card-wrapper');
  if (cardWrapper) {
    cardWrapper.classList.add('card-clicked');
  }
  
  // Remove animation classes after animation completes
  setTimeout(() => {
    starAnimation.classList.remove('active');
    if (cardWrapper) {
      cardWrapper.classList.remove('card-clicked');
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

// Handle card click - play animation and track
function handleCardClick(cardWrapper) {
  const movie = {
    title: cardWrapper.dataset.title || '',
    director: cardWrapper.dataset.director || '',
    year: cardWrapper.dataset.year || ''
  };
  
  // Play animation
  playStarAnimation(cardWrapper);
  
  // Track click in backend
  if (movie.title) {
    trackMovieClick(movie);
  }
}

// Add click handlers to all card wrappers
cardWrappers.forEach(wrapper => {
  const productCard = wrapper.querySelector('.product-card');
  const favoriteBtn = wrapper.querySelector('.favorite-btn');
  
  // Card click handler - also toggles the star button
  if (productCard) {
    productCard.addEventListener('click', () => {
      if (favoriteBtn) {
        // Only play animation if not already active
        if (!favoriteBtn.classList.contains('active')) {
          handleCardClick(wrapper);
        }
        favoriteBtn.classList.toggle('active');
      }
    });
  }
  
  // Star button click handler
  if (favoriteBtn) {
    favoriteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent triggering card click
      // Only play animation if not already active
      if (!favoriteBtn.classList.contains('active')) {
        handleCardClick(wrapper);
      }
      favoriteBtn.classList.toggle('active');
    });
  }
});

// Scroll indicators - click to scroll to next section
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

// Back to top button
const backToTop = document.getElementById('backToTop');
if (backToTop) {
  backToTop.addEventListener('click', () => {
    snapContainer.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  });
}

// Coffee button style based on current section
const coffeeBtn = document.querySelector('.coffee-btn-fixed');
if (coffeeBtn && snapContainer) {
  // Update coffee button style based on scroll position
  function updateCoffeeButtonStyle() {
    const scrollTop = snapContainer.scrollTop;
    const sectionHeight = window.innerHeight;
    const currentSection = Math.round(scrollTop / sectionHeight);
    
    // First section (hero) = light button, other sections = dark button
    if (currentSection === 0) {
      coffeeBtn.classList.remove('dark-section');
    } else {
      coffeeBtn.classList.add('dark-section');
    }
  }
  
  // Listen for scroll events
  snapContainer.addEventListener('scroll', updateCoffeeButtonStyle);
  
  // Initial check
  updateCoffeeButtonStyle();
}

