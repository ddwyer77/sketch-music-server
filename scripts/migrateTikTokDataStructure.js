import { db } from '../firebaseAdmin.js';

console.log('Script started');
console.log('About to call migrateTikTokDataStructure');

async function migrateTikTokDataStructure(userId) {
    console.log('Inside migrateTikTokDataStructure function');
    console.log('User ID:', userId);
    
    const userDoc = await db.collection('users').doc(userId).get();
    console.log('Got user document');
    
    const userData = userDoc.data();
    console.log('User data:', userData);
    
    // Check if already migrated or no tiktok data
    if (!userData.tiktokData || typeof userData.tiktokData !== 'object') {
        return;
    }
    
    // Check if it's the old structure (has uniqueId directly)
    if (userData.tiktokData.uniqueId) {
        const oldData = userData.tiktokData;
        const newData = {
            [oldData.uniqueId]: {
                ...oldData,
                verifiedAt: userData.updatedAt || Date.now(),
                isVerified: true
            }
        };
        
        await db.collection('users').doc(userId).update({
            tiktokData: newData
        });
    }
}

async function migrateAllUsers() {
    try {
        const usersSnapshot = await db.collection('users')
            .where('tiktokVerified', '==', true)
            .get();
        
        console.log(`Found ${usersSnapshot.docs.length} users with TikTok data to migrate`);
        
        for (const userDoc of usersSnapshot.docs) {
            try {
                await migrateTikTokDataStructure(userDoc.id);
                console.log(`✅ Migrated user: ${userDoc.id}`);
            } catch (error) {
                console.error(`❌ Failed to migrate user ${userDoc.id}:`, error);
            }
        }
        
        console.log('Migration complete!');
    } catch (error) {
        console.error('Migration failed:', error);
    }
}

// node scripts/migrateTikTokDataStructure.js
migrateTikTokDataStructure("WgEV1VtUgZMK4UoOjNr3uukL4Si2")
    .catch(err => {
        console.error('Error migrating TikTok data structure:', err);
        process.exit(1);
    });

// migrateAllUsers();
