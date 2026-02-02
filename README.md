🎬 AI Movie Recommendation Platform

A personalized movie recommendation website that uses your Letterboxd watch history and the Gemini 3 API to suggest films tailored to your taste.

By analyzing the movies you’ve already watched, the platform generates recommendations that go beyond generic ratings and trends.

🚀 How It Works

-> Export your Letterboxd data
-> Download your data from Letterboxd and locate the watched.csv file.

-> Upload your watch history
-> Upload the watched.csv file to the website.


The platform analyzes your viewing history using the Gemini 3 API and returns 3 personalized movie recommendations.

✨ Features

Personalized recommendations based on real watch history

No account or login required

Simple CSV upload workflow

AI-powered suggestions using Gemini 3

Privacy-focused (no data storage)

🛠 Tech Stack

Frontend: TBD

Backend: Flask, python

AI: Gemini 3 API

Data Input: Letterboxd watched.csv


Only watched.csv is used. Other files in the export are ignored(TBD for better scoring)

⚙️ Setup & Installation
git clone https://github.com/your-username/your-repo-name.git
cd your-repo-name
npm install
npm run dev
