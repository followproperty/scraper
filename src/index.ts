import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { db } from './config/db';
import { Lead } from './models/Lead';
import scraperRouter from './routes/scraper.routes';

dotenv.config();

// Apply Stealth Plugin to puppeteer-extra
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Mount scraper routes
app.use('/api/v1/scraper', scraperRouter);

app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'Express backend with Puppeteer Stealth is running!',
    dbReadyState: db.readyState
  });
});

app.post('/leads', async (req, res) => {
  try {
    const { name, phone, rating, address, projectTargeted } = req.body;
    const newLead = new Lead({ name, phone, rating, address, projectTargeted });
    await newLead.save();
    res.status(201).json(newLead);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
