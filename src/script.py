from flask import Flask, request, jsonify
from flask_cors import CORS
import csv
import io

app = Flask(__name__)
CORS(app)  # Enable CORS for frontend requests

@app.route('/upload', methods=['POST'])
def upload_file():
    """Handle CSV file upload and parse its contents"""
    
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
        
        # Parse CSV data
        parsed_data = []
        for row in csv_reader:
            parsed_data.append({
                'date': row.get('Date', ''),
                'name': row.get('Name', ''),
                'year': row.get('Year', ''),
                'letterboxd_uri': row.get('Letterboxd URI', '')
            })
        
        # Return success response with parsed data
        return jsonify({
            'message': 'CSV uploaded and parsed successfully',
            'rows': len(parsed_data),
            'data': parsed_data
        }), 200
    
    except Exception as e:
        return jsonify({'error': f'Failed to parse CSV: {str(e)}'}), 500


@app.route('/', methods=['GET'])
def index():
    """Simple endpoint to check if server is running"""
    return jsonify({'status': 'Flask server is running'}), 200


if __name__ == '__main__':
    app.run(debug=True, host='127.0.0.1', port=5000)