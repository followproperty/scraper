import fs from 'fs';
import path from 'path';
import { db } from '../config/db';
import { ScrapedQuery } from '../models/ScrapedQuery';
import { scrapeGoogleMaps } from '../services/scraper.service';

// Manually parse .env if variables are not already loaded in the environment
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envFileContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envFileContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...values] = trimmed.split('=');
      const envKey = key.trim();
      const envValue = values.join('=').trim();
      if (!process.env[envKey]) {
        process.env[envKey] = envValue;
      }
    }
  }
}

interface IProjectConfig {
  projectName: string;
  collectionName: string;
  targetStates: string[];
  cities: string[];
  niches: string[];
  maxDailyLeads: number;
}

async function main() {
  console.log('\n======================================================');
  console.log('🚀 CRM Google Maps Scraper Pipeline Runner');
  console.log('======================================================');
  console.log('Connecting to CRM Database Cluster...');
  
  await new Promise<void>((resolve) => {
    if (db.readyState === 1) {
      resolve();
    } else {
      db.once('connected', () => resolve());
    }
  });
  console.log('✅ Connection to CRM Cluster established successfully.');

  // Load project configuration (source of truth)
  const configPath = path.resolve(__dirname, '../config/project_config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found at ${configPath}`);
    process.exit(1);
  }

  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config: IProjectConfig = JSON.parse(configContent);

  console.log(`\n📋 Profile Active Project: "${config.projectName}"`);
  console.log(`📋 Destination Collection: "${config.collectionName}"`);
  console.log(`📋 Target New Leads Target: ${config.maxDailyLeads} leads`);

  let totalSavedThisRun = 0;
  const targetNewLeads = config.maxDailyLeads || 300;
  const sessionStats = {
    processedCount: 0,
    savedCount: 0,
    phoneSkipCount: 0,
    duplicateSkipCount: 0,
    emailsFoundCount: 0,
    premiumHNICount: 0,
    queriesAttempted: 0
  };

  // Run in a loop rotating queries until target leads are successfully scraped
  while (totalSavedThisRun < targetNewLeads) {
    // 1. Fetch completed scrapes for this project inside the loop to maintain fresh state
    const completedQueries = await ScrapedQuery.find({ projectName: config.projectName });
    const completedKeys = new Set(
      completedQueries.map((q) => `${q.niche.toLowerCase()}::${q.city.toLowerCase()}`)
    );

    // 2. Generate Cartesian product of niches x cities
    const queryPool: { niche: string; city: string }[] = [];
    for (const niche of config.niches) {
      for (const city of config.cities) {
        queryPool.push({ niche, city });
      }
    }

    // 3. Filter out completed ones
    let pendingPool = queryPool.filter(
      (q) => !completedKeys.has(`${q.niche.toLowerCase()}::${q.city.toLowerCase()}`)
    );

    // 4. If all combinations in pool are completed, reset logs to restart rotation
    if (pendingPool.length === 0) {
      console.log('\n🔄 All search combinations completed! Resetting rotation logs to start fresh.');
      await ScrapedQuery.deleteMany({ projectName: config.projectName });
      // Fetch fresh empty state
      pendingPool = queryPool;
    }

    // 5. Pick current query in queue
    const currentQuery = pendingPool[0];
    
    // Safety check: if no query is resolvable, exit loop
    if (!currentQuery) {
      console.log('⚠️ No query combinations found in project config. Exiting loop.');
      break;
    }

    console.log(`\n======================================================`);
    console.log(`🎯 CURRENT ITERATION: "${currentQuery.niche}" in "${currentQuery.city}"`);
    console.log(`📈 Running Target Milestone Progress: [${totalSavedThisRun}/${targetNewLeads}] Leads Scraped`);
    console.log(`======================================================`);

    sessionStats.queriesAttempted++;

    try {
      // Execute scraper for current query
      const stats = await scrapeGoogleMaps(
        currentQuery.niche,
        currentQuery.city,
        config.projectName,
        config.collectionName,
        Math.max(0, targetNewLeads - totalSavedThisRun)
      );

      // Accumulate session stats
      totalSavedThisRun += stats.savedCount;
      sessionStats.processedCount += stats.processedCount;
      sessionStats.savedCount += stats.savedCount;
      sessionStats.phoneSkipCount += stats.phoneSkipCount;
      sessionStats.duplicateSkipCount += stats.duplicateSkipCount;
      sessionStats.emailsFoundCount += stats.emailsFoundCount;
      sessionStats.premiumHNICount += stats.premiumHNICount;

      // Log current query as completed to rotate to next query in next iteration
      await ScrapedQuery.create({
        projectName: config.projectName,
        city: currentQuery.city,
        niche: currentQuery.niche
      });

      console.log(`\n🔄 Saved run query log for: niche="${currentQuery.niche}", city="${currentQuery.city}"`);
      
      // If we got 0 new leads and processed 0 listings (e.g. empty results or network drop) 
      // check to prevent infinite loop on empty cities
      if (stats.processedCount === 0 && stats.savedCount === 0) {
        console.log('⚠️ Current query yielded zero results. Moving to next combination.');
      }

      // Small break between browser runs to safeguard IP reputation
      if (totalSavedThisRun < targetNewLeads) {
        console.log('\n⏱️ Pacing loop: Waiting 10 seconds before initiating next search query rotation...');
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

    } catch (err: any) {
      console.error(`❌ Iteration run failed for query [${currentQuery.niche}] in [${currentQuery.city}]:`, err.message);
      console.log('⏱️ Pacing loop: Waiting 15 seconds before retry...');
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }

  // Print final consolidated report of the entire session
  console.log(`\n======================================================`);
  console.log(`        📊 FINAL SESSION SUMMARY REPORT`);
  console.log(`======================================================`);
  console.log(`* Active Project Name:   "${config.projectName}"`);
  console.log(`* Destination Collection: "${config.collectionName}"`);
  console.log(`* Iterations Attempted:  ${sessionStats.queriesAttempted} search queries`);
  console.log(`* Listings Processed:     ${sessionStats.processedCount} places`);
  console.log(`* Unique Leads Saved:     ${sessionStats.savedCount} new leads`);
  console.log(`* Duplicate Skips:        ${sessionStats.duplicateSkipCount} leads (skipped)`);
  console.log(`* Phone-less Skips:       ${sessionStats.phoneSkipCount} leads (skipped)`);
  console.log(`* Emails Extracted:       ${sessionStats.emailsFoundCount} email addresses`);
  console.log(`* AI Premium HNIs:        ${sessionStats.premiumHNICount} leads tagged as Premium`);
  console.log(`======================================================`);
  console.log('✅ Pipeline runner completed active target successfully.');
  
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Fatal error in runner main execution:', err);
  process.exit(1);
});
