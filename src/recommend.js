// Dark Mode Toggle
const darkModeToggle = document.getElementById('darkModeToggle');
const moonIcon = document.querySelector('.moon-icon');
const sunIcon = document.querySelector('.sun-icon');

// Check for saved dark mode preference
if (localStorage.getItem('darkMode') === 'enabled') {
  document.body.classList.add('dark-mode');
  moonIcon.style.display = 'none';
  sunIcon.style.display = 'block';
}

darkModeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark-mode');
  
  if (document.body.classList.contains('dark-mode')) {
    localStorage.setItem('darkMode', 'enabled');
    moonIcon.style.display = 'none';
    sunIcon.style.display = 'block';
  } else {
    localStorage.setItem('darkMode', 'disabled');
    moonIcon.style.display = 'block';
    sunIcon.style.display = 'none';
  }
});

// Favorite button toggle
const favoriteButtons = document.querySelectorAll('.favorite-btn');

favoriteButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
  });
});
