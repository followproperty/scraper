import { Schema, Document, Model } from 'mongoose';
import { db } from '../config/db';

export interface ILead extends Document {
  name?: string;
  phone: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  address?: string;
  city?: string;
  state?: string;
  email?: string;
  source: string;
  sourceType?: string;
  sourceName?: string;
  projectName?: string;
  sourceDetails?: Record<string, any>;
  scrapedAt: Date;
}

const LeadSchema = new Schema<ILead>({
  name: { type: String },
  phone: { type: String, required: true },
  primaryPhone: { type: String },
  secondaryPhone: { type: String },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  email: { type: String },
  source: { type: String, default: "SCRAPER" },
  sourceType: { type: String, default: "GOOGLE_MAPS" },
  sourceName: { type: String, default: "google_maps_scraper" },
  projectName: { type: String },
  sourceDetails: { type: Schema.Types.Mixed },
  scrapedAt: { type: Date, default: Date.now }
});

// Index phone number uniquely per collection to prevent duplicates
LeadSchema.index({ phone: 1 }, { unique: true });

/**
 * Returns a Mongoose model compiled dynamically for the target collection name.
 */
export function getDynamicLeadModel(collectionName: string): Model<ILead> {
  if (db.models[collectionName]) {
    return db.models[collectionName] as Model<ILead>;
  }
  // Model name should start with uppercase letter and be camelCase
  const modelName = collectionName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return db.model<ILead>(modelName, LeadSchema, collectionName);
}

export const Lead = db.models.Lead || db.model<ILead>('Lead', LeadSchema, 'leads');
