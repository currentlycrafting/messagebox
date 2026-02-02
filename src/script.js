// JavaScript to handle drag & drop and send CSV to backend
const dropArea = document.getElementById('fileUpload');

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

  const file = e.dataTransfer.files[0];
  if (!file) return;

  // Validate CSV (checks both type and extension for browser compatibility)
  if (file.type !== "text/csv" && !file.name.endsWith(".csv")) {
    alert("Please drop a valid CSV file!");
    return;
  }

  // Send CSV to Python backend
  const formData = new FormData();
  formData.append("file", file);

  fetch("http://127.0.0.1:5000/upload", {
    method: "POST",
    body: formData
  })
  .then(response => response.json())
  .then(data => { console.log(data); alert(`Server Response: ${data.message}, Rows: ${data.rows}`); })
  .catch(error => { console.error("Error:", error); alert("Failed to upload CSV."); });
});
