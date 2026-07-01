import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/primary_scraping';

export const db = mongoose.createConnection(MONGO_URI);

db.on('connected', () => {
  console.log('Mongoose: Connected to database successfully.');
});

db.on('error', (err) => {
  console.error('Mongoose: Database connection error:', err);
});
