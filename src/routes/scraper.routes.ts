import { Router } from 'express';
import { handleScrapeRequest, handleScrapeLoopRequest } from '../controllers/scraper.controller';

const router = Router();

// Single query scrape endpoint
router.post('/', handleScrapeRequest);

// Automated rotating loop scrape endpoint (runs asynchronously in the background)
router.post('/run-loop', handleScrapeLoopRequest);

export default router;
