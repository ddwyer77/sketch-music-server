import { db } from './firebaseAdmin.js';
import axios from 'axios';

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

export async function getTikTokVideoData(url) {
  try {
    // Extract video ID from URL
    const idMatch = url.match(/\/video\/(\d+)/);
    if (!idMatch || !idMatch[1]) {
      throw new Error('Could not extract video ID from URL: ' + url);
    }
    
    const videoId = idMatch[1];
    
    const response = await axios({
      method: 'GET',
      url: 'https://tiktok-api23.p.rapidapi.com/api/post/detail',
      params: { videoId },
      headers: {
        'x-rapidapi-key': process.env.RAPID_API_KEY,
        'x-rapidapi-host': 'tiktok-api23.p.rapidapi.com'
      },
      timeout: 10000
    });

    const data = response.data;
    
    // Extract the metrics we care about
    const stats = data?.itemInfo?.itemStruct?.stats;
    const music = data?.itemInfo?.itemStruct?.music;
    const author = data?.itemInfo?.itemStruct?.author;
    
    return {
      id: videoId,
      title: data?.shareMeta?.title || '',
      author: author ? {
        nickname: author.nickname,
        uniqueId: author.uniqueId
      } : undefined,
      views: stats?.playCount || 0,
      shares: stats?.shareCount || 0,
      comments: stats?.commentCount || 0,
      likes: stats?.diggCount || 0,
      description: data?.itemInfo?.itemStruct?.desc || '',
      createdAt: data?.itemInfo?.itemStruct?.createTime 
        ? new Date(data.itemInfo.itemStruct.createTime * 1000).toISOString() 
        : '',
      musicTitle: music?.title || '',
      musicAuthor: music?.authorName || '',
      musicId: music?.id || ''
    };
  } catch (error) {
    console.error('Error fetching TikTok data:', error);
    throw error;
  }
}

export async function videoContainsRequiredSound(videoUrl, campaign) {
    const videoData = await getTikTokVideoData(videoUrl);
    const submissionSoundId = videoData.musicId;
    const campaignSoundId = campaign.soundId;

    if (submissionSoundId == campaignSoundId) {
        return true;
    }

    return false;
}

// Export sanitization functions for use in other files
export {
    sanitizeDiscordId,
    sanitizeToken,
    sanitizeUrl,
    sanitizeCampaignId
}; 
