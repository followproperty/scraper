import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getDynamicLeadModel } from '../models/Lead';
import { scrapeWebsiteContacts, calculateHNIScore } from './enrichment.service';

// Apply Stealth Plugin to puppeteer-extra
puppeteer.use(StealthPlugin());

/**
 * Interface representing the scrape results counts
 */
interface IScrapeResult {
  processedCount: number;
  savedCount: number;
  phoneSkipCount: number;
  duplicateSkipCount: number;
  emailsFoundCount: number;
  premiumHNICount: number;
  aiEngineUsed: string;
}

/**
 * Delay helper
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Random delay to mimic human behavior
 */
const randomDelay = () => delay(Math.floor(Math.random() * 3000) + 2000);

/**
 * Main scraper task execution
 */
export async function scrapeGoogleMaps(
  keyword: string,
  location: string,
  projectTargeted: string,
  collectionName: string,
  remainingLeadsNeeded?: number
): Promise<IScrapeResult> {
  const aiEngine = process.env.GROQ_API_KEY
    ? 'GROQ'
    : process.env.GEMINI_API_KEY
    ? 'GEMINI'
    : 'LOCAL_RULES';

  console.log(`\n[🔍 Scraper] Target: "${keyword}" in "${location}"`);
  console.log(`[🔍 Scraper] Project: "${projectTargeted}" | Database Collection: "${collectionName}"`);
  console.log(`[🔍 Scraper] AI Engine Configured: [${aiEngine}]`);
  if (remainingLeadsNeeded !== undefined) {
    console.log(`[🔍 Scraper] Target limit active: Stopping after saving ${remainingLeadsNeeded} more leads`);
  }
  console.log('------------------------------------------------------------');

  const stats: IScrapeResult = {
    processedCount: 0,
    savedCount: 0,
    phoneSkipCount: 0,
    duplicateSkipCount: 0,
    emailsFoundCount: 0,
    premiumHNICount: 0,
    aiEngineUsed: aiEngine
  };

  // Launch browser with stealth plugin enabled and memory-efficient parameters
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,800',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--js-flags="--max-opt-level=2 --max-old-space-size=150"',
      '--disable-application-cache',
      '--disable-cache',
      '--disk-cache-size=0',
      '--single-process',
      '--no-zygote'
    ]
  });

  const setupPage = async (p: any) => {
    await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await p.setViewport({ width: 1280, height: 800 });
    await p.setRequestInterception(true);
    p.on('request', (req: any) => {
      const type = req.resourceType();
      const url = req.url();
      if (
        ['image', 'font', 'media'].includes(type) ||
        url.includes('google-analytics') ||
        url.includes('googletagmanager')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });
  };

  try {
    let page = await browser.newPage();
    await setupPage(page);

    const query = `${keyword} in ${location}`;
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    console.log(`[🌐 Browser] Navigating to Google Maps Search URL...`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

    const feedSelector = 'div[role="feed"]';
    try {
      await page.waitForSelector(feedSelector, { timeout: 15000 });
    } catch (err) {
      console.log('⚠️ [Browser] Could not find results list or search query yielded 0 results. Skipping.');
      await browser.close();
      return stats;
    }

    // Scroll to lazy load places
    console.log('[🌐 Browser] Scrolling results side-panel to load all listings...');
    let lastHeight = await page.evaluate((feedSel) => {
      const feed = document.querySelector(feedSel);
      return feed ? feed.scrollHeight : 0;
    }, feedSelector);

    let scrollAttempts = 0;
    while (scrollAttempts < 5) {
      await page.evaluate((feedSel) => {
        const feed = document.querySelector(feedSel);
        if (feed) {
          feed.scrollTo(0, feed.scrollHeight);
        }
      }, feedSelector);

      await delay(2000);

      const newHeight = await page.evaluate((feedSel) => {
        const feed = document.querySelector(feedSel);
        return feed ? feed.scrollHeight : 0;
      }, feedSelector);

      if (newHeight === lastHeight) break;
      lastHeight = newHeight;
      scrollAttempts++;
    }

    // Extract links and names directly from the search results side panel
    const parsedPlaces = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
      return elements.map((el) => {
        const href = (el as HTMLAnchorElement).href;
        
        // Find clean name from the maps search result title element
        const parentResult = el.closest('div[class*="Nv2y1d"], div[class*="Ua34Hg"], div[class*="jVSTN"]') || el;
        const titleEl = parentResult.querySelector('.qBF1Pd') || el;
        const name = titleEl.textContent?.trim() || '';
        
        return { name, link: href };
      });
    });

    // Deduplicate lists by link
    const uniqueMap = new Map<string, string>();
    for (const item of parsedPlaces) {
      if (item.link && item.name) {
        uniqueMap.set(item.link, item.name);
      }
    }
    const uniquePlaces = Array.from(uniqueMap.entries()).map(([link, name]) => ({ link, name }));

    console.log(`[🌐 Browser] Found ${uniquePlaces.length} unique place listings to process.`);
    console.log('------------------------------------------------------------');

    const DynamicLeadModel = getDynamicLeadModel(collectionName);

    let navigationCount = 0;

    // Process each place
    for (let i = 0; i < uniquePlaces.length; i++) {
      if (remainingLeadsNeeded !== undefined && stats.savedCount >= remainingLeadsNeeded) {
        console.log(`\n🎯 [Scraper] Target milestone reached: saved ${stats.savedCount} leads. Stopping scraper early!`);
        break;
      }

      const place = uniquePlaces[i];
      const indexStr = `[${i + 1}/${uniquePlaces.length}]`;

      // 1. Early duplicate check by Name & City (Skips page loading completely in 0.1 seconds!)
      if (place.name) {
        const existsByName = await DynamicLeadModel.exists({
          name: place.name,
          city: location
        });
        if (existsByName) {
          console.log(`   ⏭️  Skipped instantly: Lead "${place.name}" already exists in database (Checked by Name)`);
          stats.duplicateSkipCount++;
          continue;
        }
      }

      try {
        // Recreate the page context every 5 actual detail navigations
        // Google Maps SPA causes memory leaks over many consecutive page loads inside the same tab.
        // Recreating the tab context completely releases the cached heap RAM memory.
        if (navigationCount > 0 && navigationCount % 5 === 0) {
          console.log('\n🧹 [Browser] Recreating page tab context to release cached RAM memory...');
          await page.close().catch(() => {});
          page = await browser.newPage();
          await setupPage(page);
        }
        navigationCount++;

        console.log(`\n${indexStr} Navigating to details...`);
        // Robust navigation settings with a 45 seconds limit to handle CPU throttling on Render
        await page.goto(place.link, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector('h1.DUwDvf', { timeout: 15000 }).catch(() => {});

        // Extract Details
        const result = await page.evaluate(() => {
          const nameEl = document.querySelector('h1.DUwDvf');
          const name = nameEl ? nameEl.textContent?.trim() || '' : '';

          const categoryEl = document.querySelector('button[class*="DkEaCc"], span[class*="DkEaCc"]');
          const category = categoryEl ? categoryEl.textContent?.trim() || '' : '';

          const ratingContainer = document.querySelector('div.F7nice');
          let rating = '';
          let reviewCount = '';
          if (ratingContainer) {
            const ratingEl = ratingContainer.querySelector('span[aria-hidden="true"]');
            rating = ratingEl ? ratingEl.textContent?.trim() || '' : '';

            const reviewsEl = ratingContainer.querySelector('button.HHrUfc, span.E3ortc');
            if (reviewsEl) {
              reviewCount = reviewsEl.textContent?.replace(/[\(\)]/g, '').trim() || '';
            } else {
              const text = ratingContainer.textContent || '';
              const match = text.match(/\((\d+)\)/);
              if (match) {
                reviewCount = match[1];
              }
            }
          }

          const addressButton = document.querySelector('button[data-item-id="address"]');
          const address = addressButton ? addressButton.textContent?.trim() || '' : '';

          const websiteAnchor = document.querySelector('a[data-item-id="authority"]');
          const website = websiteAnchor ? websiteAnchor.getAttribute('href') || '' : '';

          const phoneButton = document.querySelector('button[data-item-id^="phone:tel:"]');
          let phone = '';
          if (phoneButton) {
            const dataId = phoneButton.getAttribute('data-item-id');
            if (dataId && dataId.startsWith('phone:tel:')) {
              phone = dataId.replace('phone:tel:', '').replace(/\s+/g, '').trim();
            } else {
              phone = phoneButton.textContent?.replace(/\s+/g, '').trim() || '';
            }
          }

          return { name, category, rating, reviewCount, address, website, phone };
        });

        stats.processedCount++;

        // 2. Skip if no phone number
        if (!result.phone) {
          console.log(`   ❌ Skipped: No phone number listed for "${result.name}"`);
          stats.phoneSkipCount++;
          continue;
        }

        const phoneClean = result.phone;

        // 3. Double check by Phone to ensure absolute safety
        const existsByPhone = await DynamicLeadModel.exists({ phone: phoneClean });
        if (existsByPhone) {
          console.log(`   ⏭️  Skipped: Lead with phone ${phoneClean} ("${result.name}") already exists in database`);
          stats.duplicateSkipCount++;
          continue;
        }

        console.log(`   📝 Found Lead: "${result.name}" | Phone: "${result.phone}"`);

        // Apply delay
        await randomDelay();

        // 4. Web Contacts Extraction (Emails & Phone Numbers)
        let emailContacts: string[] = [];
        let webPhones: string[] = [];
        if (result.website) {
          const contacts = await scrapeWebsiteContacts(result.website);
          emailContacts = contacts.emails;
          webPhones = contacts.phones;
          if (emailContacts.length > 0) {
            stats.emailsFoundCount += emailContacts.length;
          }
        }

        // Compare and prioritize direct mobile number over receptionist/maps number
        const primaryPhone = (webPhones.length > 0 && webPhones[0] !== phoneClean) ? webPhones[0] : phoneClean;
        const secondaryPhone = (primaryPhone !== phoneClean) ? phoneClean : '';
        if (primaryPhone !== phoneClean) {
          console.log(`   🔄 Direct Mobile found on website! Setting primaryPhone = "${primaryPhone}" (direct) and secondaryPhone = "${secondaryPhone}" (reception)`);
        }

        // 5. HNI Score Calculation
        const scoring = await calculateHNIScore(result);
        if (scoring.isPremium) {
          stats.premiumHNICount++;
          console.log(`   💎 AI Premium Investor detected (Score: ${scoring.score}/100)`);
          if (scoring.personalizedPitch) {
            console.log(`   💡 Personal Pitch Hook: "${scoring.personalizedPitch}"`);
          }
        } else {
          console.log(`   👤 HNI Score: ${scoring.score}/100 (Standard)`);
        }

        // Map to CRM layout
        const targetLeadData = {
          name: result.name || 'Unknown Business',
          phone: primaryPhone,
          primaryPhone: primaryPhone,
          secondaryPhone: secondaryPhone,
          address: result.address || 'N/A',
          city: location,
          projectName: projectTargeted,
          email: emailContacts[0] || '',
          source: 'SCRAPER',
          sourceType: 'GOOGLE_MAPS',
          sourceName: 'google_maps_scraper',
          sourceDetails: {
            website: result.website || '',
            category: result.category || '',
            rating: result.rating || '',
            reviewsCount: result.reviewCount ? parseInt(result.reviewCount.replace(/[^\d]/g, ''), 10) || 0 : 0,
            premiumScore: scoring.score,
            premiumTag: scoring.isPremium ? 'HNI_PREMIUM' : 'STANDARD',
            scoringReasons: scoring.reasons,
            personalizedPitch: scoring.personalizedPitch || '',
            emailContacts
          },
          scrapedAt: new Date()
        };

        // Write to DB (Key on the resolved primary phone to keep phone index unique)
        await DynamicLeadModel.findOneAndUpdate(
          { phone: primaryPhone },
          { $set: targetLeadData },
          { upsert: true, returnDocument: 'after' }
        );

        console.log(`   ✅ Saved Lead successfully to CRM Cluster.`);
        stats.savedCount++;

        if (remainingLeadsNeeded !== undefined && stats.savedCount >= remainingLeadsNeeded) {
          console.log(`\n🎯 [Scraper] Target milestone reached: saved ${stats.savedCount} leads. Stopping scraper early!`);
          break;
        }
      } catch (err: any) {
        console.error(`   ⚠️ Error processing listing: ${err.message}`);
      }
    }

  } catch (error: any) {
    console.error('🔥 Scraper encountered a fatal browser crash:', error.message);
  } finally {
    await browser.close();
    console.log('\n[🌐 Browser] Closed successfully.');
  }

  return stats;
}
