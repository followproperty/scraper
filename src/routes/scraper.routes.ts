import { Router } from 'express';
import { handleScrapeRequest } from '../controllers/scraper.controller';

const router = Router();

router.post('/', handleScrapeRequest);

export default router;
