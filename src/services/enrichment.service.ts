// Local HNI enrichment service

/**
 * Interface representing scraped place details from Google Maps
 */
export interface IScrapedDetails {
  name: string;
  phone: string;
  category?: string;
  address?: string;
  website?: string;
  rating?: string;
  reviewCount?: string;
}

/**
 * Fetches the website HTML and extracts emails and phone numbers.
 * Zero external dependencies, safe, and fast (with a 4-second timeout limit).
 */
export async function scrapeWebsiteContacts(url: string): Promise<{ emails: string[]; phones: string[] }> {
  const result = { emails: [], phones: [] as string[] };
  if (!url) return result;
  
  // Standardize URL protocol
  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'http://' + targetUrl;
  }

  try {
    console.log(`Enrichment: Fetching website homepage: ${targetUrl}`);
    
    // Set a strict 4-second timeout to prevent stalling the scraper pipeline
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`Enrichment: Website returned status ${response.status}. Skipping body parse.`);
      return result;
    }

    const html = await response.text();
    
    // 1. Extract Emails using standard regex
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g;
    const emailMatches = html.match(emailRegex) || [];

    // Filter out common false positives and image files, then deduplicate
    const excludedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js'];
    result.emails = Array.from(new Set(
      emailMatches
        .map(email => email.toLowerCase().trim())
        .filter(email => {
          const hasExcludedExt = excludedExtensions.some(ext => email.endsWith(ext));
          return !hasExcludedExt && email.includes('.') && email.length > 5;
        })
    )) as any;

    // 2. Extract Phone Numbers looking like Indian mobiles
    // Matches 10 digits starting with 6-9, optionally prefixed with +91 or 0, with spacing/hyphens
    const cleanNumbers: string[] = [];
    const phoneMatches = html.match(/(?:\+91[\s\-]?)?[6-9]\d{2}[\s\-]?\d{3}[\s\-]?\d{4}/g) || [];
    for (const match of phoneMatches) {
      const clean = match.replace(/[\s\-\+\(\)\.]/g, '');
      const len = clean.length;
      let cleanedPhone = '';
      if (len === 10) {
        cleanedPhone = clean;
      } else if (len === 12 && clean.startsWith('91')) {
        cleanedPhone = clean.slice(2);
      }
      
      // Basic mobile prefix validation (starts with 6-9)
      if (cleanedPhone && /^[6-9]/.test(cleanedPhone)) {
        cleanNumbers.push(cleanedPhone);
      }
    }
    result.phones = Array.from(new Set(cleanNumbers));

    console.log(`Enrichment: Extracted ${result.emails.length} email(s) and ${result.phones.length} phone(s) from website.`);
    return result;
  } catch (err: any) {
    console.log(`Enrichment: Failed to scrape website contacts for ${targetUrl}: ${err.message}`);
    return result;
  }
}

/**
 * Calculates a zero-cost AI HNI premium score (0 - 100) using Gemini Free API if available, 
 * with a local rules-based engine fallback.
 */
export async function calculateHNIScore(details: IScrapedDetails): Promise<{ score: number; isPremium: boolean; reasons: string[]; personalizedPitch?: string }> {
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  // 1. If GROQ_API_KEY is available, use Groq Llama-3.1-8B-Instant (Costs $0, extremely fast)
  if (groqKey && groqKey.trim()) {
    try {
      console.log(`Enrichment: Using Groq Llama 3.1 to profile lead "${details.name}"...`);
      
      const prompt = `
You are an expert real estate HNI investor profiler. Analyze this local business listing to determine if the owner is likely a High Net Worth Individual (HNI) who could invest in premium residential/villa plots in Vrindavan.

Business Name: "${details.name}"
Category: "${details.category || 'N/A'}"
Website: "${details.website || 'N/A'}"
Rating: "${details.rating || 'N/A'}" (based on ${details.reviewCount || '0'} reviews)
Address: "${details.address || 'N/A'}"

Provide a JSON response with this exact structure:
{
  "score": <number from 0 to 100 representing HNI investor capability score>,
  "isPremium": <boolean, true if score >= 70>,
  "reasons": [<2 or 3 short bullet reasons for the score>],
  "personalizedPitch": "<A highly personalized 1-sentence sales pitch hook for a cold caller, e.g. 'Dr. Amit, as a leading pediatrician in Mathura, this serene gated land is a perfect long-term wealth asset for your family just 20 mins away.'>"
}
CRITICAL REQUIREMENT: The "personalizedPitch" MUST be written in professional, grammatically correct English ONLY. Do NOT write in Hinglish, Hindi, or any language other than English.
`;

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey.trim()}`
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' }
        })
      });

      if (response.ok) {
        const data = await response.json() as any;
        const text = data.choices?.[0]?.message?.content || '';
        const parsed = JSON.parse(text.trim());
        
        return {
          score: typeof parsed.score === 'number' ? parsed.score : 50,
          isPremium: !!parsed.isPremium,
          reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
          personalizedPitch: parsed.personalizedPitch || ''
        };
      } else {
        console.warn(`⚠️  [Enrichment] WARNING: Groq API returned status ${response.status}. Attempting Gemini fallback or local rules fallback.`);
      }
    } catch (e: any) {
      console.warn(`⚠️  [Enrichment] WARNING: Groq API profiling failed (${e.message}). Attempting Gemini fallback or local rules fallback.`);
    }
  }

  // 2. If GEMINI_API_KEY is available, use Gemini Free API (Costs $0)
  if (geminiKey && geminiKey.trim()) {
    try {
      console.log(`Enrichment: Using Gemini Free API to profile lead "${details.name}"...`);
      
      const prompt = `
You are an expert real estate HNI investor profiler. Analyze this local business listing to determine if the owner is likely a High Net Worth Individual (HNI) who could invest in premium residential/villa plots in Vrindavan.

Business Name: "${details.name}"
Category: "${details.category || 'N/A'}"
Website: "${details.website || 'N/A'}"
Rating: "${details.rating || 'N/A'}" (based on ${details.reviewCount || '0'} reviews)
Address: "${details.address || 'N/A'}"

Provide a JSON response with:
{
  "score": <number from 0 to 100 representing HNI investor capability score>,
  "isPremium": <boolean, true if score >= 70>,
  "reasons": [<2 or 3 short bullet reasons for the score>],
  "personalizedPitch": "<A highly personalized 1-sentence sales pitch hook for a cold caller, e.g. 'Dr. Amit, as a leading pediatrician in Mathura, this serene gated land is a perfect long-term wealth asset for your family just 20 mins away.'>"
}
Respond with raw JSON only. Do not wrap in markdown code blocks.
CRITICAL REQUIREMENT: The "personalizedPitch" MUST be written in professional, grammatically correct English ONLY. Do NOT write in Hinglish, Hindi, or any language other than English.
`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      if (response.ok) {
        const data = await response.json() as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanText);
        
        return {
          score: typeof parsed.score === 'number' ? parsed.score : 50,
          isPremium: !!parsed.isPremium,
          reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
          personalizedPitch: parsed.personalizedPitch || ''
        };
      } else {
        console.warn(`⚠️  [Enrichment] WARNING: Gemini API returned status ${response.status}. Falling back to local rules engine.`);
      }
    } catch (e: any) {
      console.warn(`⚠️  [Enrichment] WARNING: Gemini API profiling failed (${e.message}). Falling back to local rules engine.`);
    }
  }

  // 3. Local fallback (Always runs for $0 without keys)
  let score = 0;
  const reasons: string[] = [];

  // 1. Niche / Category match (Max 40 points)
  const category = (details.category || '').toLowerCase();
  const name = details.name.toLowerCase();
  
  const premiumKeywords = [
    'doctor', 'physician', 'surgeon', 'clinic', 'hospital', 'medical', 'pediatrician',
    'advocate', 'lawyer', 'law firm', 'legal', 'barrister', 'court',
    'chartered accountant', 'ca office', 'tax consultant', 'financial planner',
    'builder', 'developer', 'hotel', 'resort', 'luxury', 'real estate investment'
  ];

  const matchesKeyword = premiumKeywords.some(keyword => category.includes(keyword) || name.includes(keyword));
  if (matchesKeyword) {
    score += 40;
    reasons.push('High-income niche category match (Doctor/Lawyer/CA/Premium Business)');
  }

  // 2. Website presence (Max 20 points)
  if (details.website && details.website.trim()) {
    score += 20;
    reasons.push('Active website presence (indicates marketing budget)');
  }

  // 3. Reputation & Scale (Max 40 points)
  // Rating weight: up to 20 points
  const ratingVal = parseFloat(details.rating || '0');
  if (ratingVal > 0) {
    const ratingScore = Math.round((ratingVal / 5) * 20);
    score += ratingScore;
    if (ratingVal >= 4.2) {
      reasons.push(`Highly rated establishment: ${ratingVal}/5`);
    }
  }

  // Reviews Count weight: up to 20 points
  const parsedReviews = details.reviewCount ? parseInt(details.reviewCount.replace(/[^\d]/g, ''), 10) : 0;
  if (parsedReviews > 0) {
    const reviewsScore = Math.round((Math.min(parsedReviews, 50) / 50) * 20);
    score += reviewsScore;
    if (parsedReviews >= 20) {
      reasons.push(`Established local traction (${parsedReviews} reviews)`);
    }
  }

  const isPremium = score >= 70;
  return { score, isPremium, reasons, personalizedPitch: '' };
}
