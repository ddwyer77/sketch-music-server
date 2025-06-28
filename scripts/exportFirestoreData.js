import { db } from '../firebaseAdmin.js';
// Return as JSON data any campaign by passing in the doc id
async function exportCampaignData(campaignId) {
    if (!campaignId) {
        console.error('Please provide a campaign ID as an argument');
        console.log('Usage: node exportFirestoreData.js <campaign-id>');
        process.exit(1);
    }

    try {
        const campaignRef = db.collection('campaigns').doc(campaignId);
        const doc = await campaignRef.get();

        if (!doc.exists) {
            console.error(`Campaign with ID '${campaignId}' not found`);
            process.exit(1);
        }

        const data = doc.data();
        console.log(JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error fetching campaign data:', error);
        process.exit(1);
    }
}

// Get campaign ID from command line arguments
const campaignId = process.argv[2];
// node scripts/exportFirestoreData.js <campaign-id>

exportCampaignData(campaignId)
    .catch(err => {
        console.error('Error:', err);
        process.exit(1);
    }); 

  