import { db } from './firebaseAdmin.js';

// Input validation and sanitization
function sanitizeDiscordId(discordId) {
    // Discord IDs are 17-19 digit numbers
    if (!/^\d{17,19}$/.test(discordId)) {
        throw new Error('Invalid Discord ID format');
    }
    return discordId;
}

function sanitizeToken(token) {
    // Tokens should be hex strings of length 64 (32 bytes)
    if (!/^[a-f0-9]{64}$/.test(token)) {
        throw new Error('Invalid token format');
    }
    return token;
}

function sanitizeUrl(url) {
    try {
        const parsedUrl = new URL(url);
        // Only allow http and https protocols
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Invalid URL protocol');
        }
        return parsedUrl.toString();
    } catch (error) {
        throw new Error('Invalid URL format');
    }
}

function sanitizeCampaignId(campaignId) {
    // Firebase document IDs are 20 characters long and can contain letters, numbers, and some special characters
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(campaignId)) {
        throw new Error('Invalid campaign ID format');
    }
    return campaignId;
}

// Helper function to check if user is authenticated
export async function isUserAuthenticated(discordId) {
    try {
        const sanitizedDiscordId = sanitizeDiscordId(discordId);
        const userDoc = await db.collection('users')
            .where('discord_id', '==', sanitizedDiscordId)
            .limit(1)
            .get();
        
        return !userDoc.empty;
    } catch (error) {
        console.error('Error checking authentication:', error);
        return false;
    }
}

// Helper function to get Firebase user ID from Discord ID
export async function getFirebaseUserId(discordId) {
    try {
        const sanitizedDiscordId = sanitizeDiscordId(discordId);
        const userDoc = await db.collection('users')
            .where('discord_id', '==', sanitizedDiscordId)
            .limit(1)
            .get();
        
        if (userDoc.empty) {
            return null;
        }
        
        return userDoc.docs[0].id;
    } catch (error) {
        console.error('Error getting Firebase user ID:', error);
        return null;
    }
}

// Helper function to clean up expired tokens
export async function cleanupExpiredTokens() {
    try {
        const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
        const expiredTokens = await db.collection('discord_login_tokens')
            .where('expires_at', '<', thirtyMinutesAgo)
            .get();
        
        const batch = db.batch();
        expiredTokens.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        
        console.log(`Cleaned up ${expiredTokens.size} expired tokens`);
    } catch (error) {
        console.error('Error cleaning up expired tokens:', error);
    }
}

// Export sanitization functions for use in other files
export {
    sanitizeDiscordId,
    sanitizeToken,
    sanitizeUrl,
    sanitizeCampaignId
}; 