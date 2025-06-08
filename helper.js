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

// Check if a campaign meets completion criteria
export function checkCampaignCompletionCriteria(campaign) {
    // TODO: Implement end date check when campaign end dates are added
    // if (campaign.endDate && new Date(campaign.endDate) < new Date()) {
    //     return true;
    // }

    // Check if budget has been reached
    if (campaign.budget && campaign.budgetUsed >= campaign.budget) {
        return true;
    }

    // Check if max submissions has been reached
    if (campaign.maxSubmissions && campaign.videos?.length >= campaign.maxSubmissions) {
        return true;
    }

    return false;
}

// Update all campaign metrics
export async function updateAllCampaignMetrics() {
    const campaignsSnapshot = await db.collection('campaigns').get();
    const campaigns = campaignsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    for (const campaign of campaigns) {
        // Skip if campaign is already marked as complete
        if (campaign.isComplete) {
            continue;
        }

        if (!campaign.videos || !campaign.videos.length) {
            // If no videos, set all metrics to 0
            await db.collection('campaigns').doc(campaign.id).update({
                views: 0,
                shares: 0,
                comments: 0,
                likes: 0,
                budgetUsed: 0,
                lastUpdated: Date.now()
            });
            continue;
        }

        try {
            // Fetch metrics for each video URL in the campaign
            const metricsPromises = campaign.videos.map(async video => {
                const metrics = await getTikTokVideoData(video.url);
                // Check if the video's music ID matches the campaign's sound ID
                const soundIdMatch = campaign.soundId ? metrics.musicId === campaign.soundId : false;
                return { ...metrics, soundIdMatch };
            });
            const metricsArray = await Promise.all(metricsPromises);

            // Update videos with sound ID match information and metrics
            const updatedVideos = campaign.videos.map((video, index) => ({
                ...video,
                soundIdMatch: metricsArray[index].soundIdMatch,
                // Add TikTok metrics to each video
                views: metricsArray[index].views || 0,
                shares: metricsArray[index].shares || 0,
                comments: metricsArray[index].comments || 0,
                likes: metricsArray[index].likes || 0,
                title: metricsArray[index].title || '',
                description: metricsArray[index].description || '',
                createdAt: metricsArray[index].createdAt || '',
                musicTitle: metricsArray[index].musicTitle || '',
                musicAuthor: metricsArray[index].musicAuthor || '',
                musicId: metricsArray[index].musicId || '',
                author: metricsArray[index].author
            }));

            // Calculate total metrics by summing up all video metrics
            const totalMetrics = updatedVideos.reduce((total, video) => ({
                views: total.views + (video.views || 0),
                shares: total.shares + (video.shares || 0),
                comments: total.comments + (video.comments || 0),
                likes: total.likes + (video.likes || 0)
            }), { views: 0, shares: 0, comments: 0, likes: 0 });

            // Calculate budget used based on total views and campaign rate, rounded to nearest integer
            const budgetUsed = Math.round((totalMetrics.views / 1000000) * (campaign.ratePerMillion || 0));

            // Check if campaign should be marked as complete based on new metrics
            const completionStatus = checkCampaignCompletionCriteria({
                ...campaign,
                budgetUsed,
                videos: updatedVideos
            });

            // Include additional metrics in the update
            const campaignUpdate = {
                views: totalMetrics.views,      // Sum of all video.views
                shares: totalMetrics.shares,    // Sum of all video.shares
                comments: totalMetrics.comments, // Sum of all video.comments
                likes: totalMetrics.likes,      // Sum of all video.likes
                budgetUsed,
                isComplete: completionStatus,
                lastUpdated: Date.now(),
                videos: updatedVideos
            };

            updatedVideos.forEach((video, index) => {
                console.log(`Video ${index + 1}:`, {
                    views: video.views,
                    shares: video.shares,
                    comments: video.comments,
                    likes: video.likes
                });
            });

            // Update campaign in Firestore
            await db.collection('campaigns').doc(campaign.id).update(campaignUpdate);
        } catch (error) {
            console.error(`Error updating metrics for campaign ${campaign.id}:`, error);
        }
    }
}

// Export sanitization functions for use in other files
export {
    sanitizeDiscordId,
    sanitizeToken,
    sanitizeUrl,
    sanitizeCampaignId
}; 
