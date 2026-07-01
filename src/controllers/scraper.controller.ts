import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { scrapeGoogleMaps } from '../services/scraper.service';
import { ScrapedQuery } from '../models/ScrapedQuery';

interface IProjectConfig {
  projectName: string;
  collectionName: string;
  targetStates: string[];
  cities: string[];
  niches: string[];
  maxDailyLeads: number;
}

// Global flag to prevent concurrent loop runs
let isLoopRunning = false;

// API key authentication setup (Fall back to a default secret if not defined in environment variables)
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || 'fp_scraper_secret_secure_key';

/**
 * Validates the request headers or query params for security.
 */
function isAuthorized(req: Request): boolean {
  const incomingKey = req.headers['x-api-key'] || req.query.apiKey;
  return incomingKey === SCRAPER_API_KEY;
}

export async function handleScrapeRequest(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Access Denied: Invalid or missing "x-api-key" header.'
    });
    return;
  }

  try {
    const { keyword, location, projectTargeted, collectionName } = req.body;

    // Validation
    if (
      typeof keyword !== 'string' || !keyword.trim() ||
      typeof location !== 'string' || !location.trim() ||
      typeof projectTargeted !== 'string' || !projectTargeted.trim()
    ) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Parameters "keyword", "location", and "projectTargeted" must be non-empty strings.'
      });
      return;
    }

    const targetCollection = (typeof collectionName === 'string' && collectionName.trim())
      ? collectionName.trim()
      : 'leads';

    console.log(`Controller: Starting single scrape query: [${keyword}] in [${location}], saving to "${targetCollection}"`);

    // Call service layer (single run)
    const stats = await scrapeGoogleMaps(keyword.trim(), location.trim(), projectTargeted.trim(), targetCollection);

    res.status(200).json({
      status: 'success',
      message: 'Scraping process completed successfully.',
      leadsProcessed: stats.savedCount,
      details: stats
    });
  } catch (error: any) {
    console.error('Controller: Exception during Google Maps scraping request:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred during the scraping process.',
      details: error.message
    });
  }
}

/**
 * Triggers the automated query rotation loop in the background.
 * Returns immediate HTTP response so the client connection doesn't timeout.
 */
export async function handleScrapeLoopRequest(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({
      status: 'error',
      message: 'Access Denied: Invalid or missing "x-api-key" header.'
    });
    return;
  }

  if (isLoopRunning) {
    res.status(409).json({
      status: 'error',
      message: 'An automated scraping session is already running in the background.'
    });
    return;
  }

  // Load project configuration (source of truth)
  const configPath = path.resolve(__dirname, '../config/project_config.json');

  try {
    let config: IProjectConfig;
    const body = req.body;

    // Check if custom config parameters are passed directly in the HTTP POST request body
    if (
      body &&
      typeof body.projectName === 'string' && body.projectName.trim() &&
      typeof body.collectionName === 'string' && body.collectionName.trim() &&
      Array.isArray(body.cities) && body.cities.length > 0 &&
      Array.isArray(body.niches) && body.niches.length > 0
    ) {
      console.log('Controller: Loading dynamic configuration parameters directly from API request body...');
      config = {
        projectName: body.projectName.trim(),
        collectionName: body.collectionName.trim(),
        targetStates: Array.isArray(body.targetStates) ? body.targetStates : [],
        cities: body.cities.map((c: any) => String(c).trim()),
        niches: body.niches.map((n: any) => String(n).trim()),
        maxDailyLeads: typeof body.maxDailyLeads === 'number' ? body.maxDailyLeads : 300
      };
    } else {
      // Fallback: load default configuration from project_config.json file
      if (!fs.existsSync(configPath)) {
        res.status(500).json({
          status: 'error',
          message: `Default config file not found at ${configPath} and no valid body parameters provided.`
        });
        return;
      }
      console.log('Controller: Loading default configuration from project_config.json file...');
      const configContent = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(configContent);
    }

    // Set lock flag
    isLoopRunning = true;

    // Trigger the loop asynchronously in the background
    runBackgroundLoop(config).catch((err) => {
      console.error('Background Scraper Loop failed with fatal error:', err);
    }).finally(() => {
      isLoopRunning = false;
    });

    // Send immediate response
    res.status(202).json({
      status: 'processing',
      message: 'Automated scraping loop started successfully in the background.',
      targetNewLeads: config.maxDailyLeads,
      projectName: config.projectName,
      collectionName: config.collectionName,
      cities: config.cities,
      niches: config.niches
    });

  } catch (err: any) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to initialize background scraper loop.',
      details: err.message
    });
  }
}

/**
 * Executes the continuous scraping loop in the background.
 */
async function runBackgroundLoop(config: IProjectConfig): Promise<void> {
  console.log('\n======================================================');
  console.log('🤖 BACKGROUND TASK: Initiating Scraper loop execution');
  console.log('======================================================');

  let totalSavedThisRun = 0;
  const targetNewLeads = config.maxDailyLeads || 300;
  let queriesAttempted = 0;

  while (totalSavedThisRun < targetNewLeads) {
    // 1. Fetch completed query logs
    const completedQueries = await ScrapedQuery.find({ projectName: config.projectName });
    const completedKeys = new Set(
      completedQueries.map((q) => `${q.niche.toLowerCase()}::${q.city.toLowerCase()}`)
    );

    // 2. Generate Cartesian product
    const queryPool: { niche: string; city: string }[] = [];
    for (const niche of config.niches) {
      for (const city of config.cities) {
        queryPool.push({ niche, city });
      }
    }

    // 3. Filter pending
    let pendingPool = queryPool.filter(
      (q) => !completedKeys.has(`${q.niche.toLowerCase()}::${q.city.toLowerCase()}`)
    );

    // 4. Reset if pool is exhausted
    if (pendingPool.length === 0) {
      console.log('\n🔄 Background Runner: All combinations completed. Resetting logs.');
      await ScrapedQuery.deleteMany({ projectName: config.projectName });
      pendingPool = queryPool;
    }

    const currentQuery = pendingPool[0];
    if (!currentQuery) {
      console.log('⚠️ Background Runner: No queries available. Breaking.');
      break;
    }

    console.log(`\n🤖 Background Iteration: "${currentQuery.niche}" in "${currentQuery.city}" [Progress: ${totalSavedThisRun}/${targetNewLeads}]`);

    queriesAttempted++;

    try {
      const stats = await scrapeGoogleMaps(
        currentQuery.niche,
        currentQuery.city,
        config.projectName,
        config.collectionName
      );

      totalSavedThisRun += stats.savedCount;

      // Log completed query
      await ScrapedQuery.create({
        projectName: config.projectName,
        city: currentQuery.city,
        niche: currentQuery.niche
      });

      if (totalSavedThisRun < targetNewLeads) {
        console.log('\n⏱️ Background Runner: Pacing 10 seconds wait...');
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    } catch (err: any) {
      console.error(`❌ Background Runner: Error on query [${currentQuery.niche}] in [${currentQuery.city}]:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }

  console.log('\n======================================================');
  console.log(`🏁 BACKGROUND TASK COMPLETED: Saved ${totalSavedThisRun} new HNI leads.`);
  console.log('======================================================\n');
}
