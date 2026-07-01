import dotenv from 'dotenv';
import { db } from './config/db';
import { Lead } from './models/Lead';

dotenv.config();

console.log('Connecting to database...');

db.on('open', async () => {
  console.log('Database connection opened successfully.');
  
  try {
    const testLead = {
      name: 'Test Lead (Connection Verification)',
      phone: '+919999999999',
      rating: '5.0',
      address: '123 Test Street, Gurgaon',
      projectTargeted: 'Vrindavan Plots',
      scrapedAt: new Date()
    };

    console.log('Upserting test lead into database...');
    const savedLead = await Lead.findOneAndUpdate(
      { phone: testLead.phone },
      testLead,
      { upsert: true, new: true }
    );

    console.log('Success! Saved Lead Details:', savedLead);
  } catch (err: any) {
    console.error('Error executing query:', err.message);
  } finally {
    await db.close();
    console.log('Database connection closed.');
    process.exit(0);
  }
});

db.on('error', (err) => {
  console.error('Connection error:', err);
  process.exit(1);
});
