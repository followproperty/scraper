import { Schema, Document } from 'mongoose';
import { db } from '../config/db';

export interface IScrapedQuery extends Document {
  projectName: string;
  city: string;
  niche: string;
  scrapedAt: Date;
}

const ScrapedQuerySchema = new Schema<IScrapedQuery>({
  projectName: { type: String, required: true },
  city: { type: String, required: true },
  niche: { type: String, required: true },
  scrapedAt: { type: Date, default: Date.now }
});

// Indexes for fast querying of completed rotations
ScrapedQuerySchema.index({ projectName: 1, city: 1, niche: 1 });

export const ScrapedQuery = db.model<IScrapedQuery>('ScrapedQuery', ScrapedQuerySchema);
