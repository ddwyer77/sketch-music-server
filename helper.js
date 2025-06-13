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

function sanitizeTikTokId(id) {
  if (typeof id !== 'string') {
    throw new Error('TikTok ID must be a string');
  }

  const trimmed = id.trim();

  // Only allow a-z, A-Z, 0-9, underscore, and period
  const safe = trimmed.replace(/[^a-zA-Z0-9._]/g, '');

  // Optionally enforce length limits (TikTok allows 4–24)
  if (safe.length < 4 || safe.length > 24) {
    throw new Error('TikTok ID must be between 4 and 24 valid characters');
  }

  return safe;
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
    // Check if it's a shortened URL
    if (url.includes('/t/')) {
      try {
        // Follow the redirect to get the full URL
        const response = await axios({
          method: 'GET',
          url: url,
          maxRedirects: 5,
          validateStatus: function (status) {
            return status >= 200 && status < 400; // Accept redirects
          }
        });
        
        // Get the final URL after redirects
        url = response.request.res.responseUrl;
      } catch (error) {
        console.error('Error resolving shortened URL:', error);
        throw new Error('Could not resolve shortened URL. Please use the full video URL.');
      }
    }

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
                author: metricsArray[index].author,
                earnings: calculateEarnings(campaign, metricsArray[index].views || 0, video.earnings)
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

            // Update campaign in Firestore
            await db.collection('campaigns').doc(campaign.id).update(campaignUpdate);
        } catch (error) {
            console.error(`Error updating metrics for campaign ${campaign.id}:`, error);
        }
    }
}

function calculateEarnings(campaign, views, currentEarnings = 0) {
    // Input validation
    if (!campaign || typeof views !== 'number' || isNaN(views)) {
        console.error('Invalid input to calculateEarnings:', { campaign, views });
        return 0;
    }

    // For completed campaigns, return existing earnings if available
    if (campaign.isComplete) {
        return typeof currentEarnings === 'number' ? currentEarnings : 0;
    }

    // Ensure ratePerMillion is a valid number
    const rate = Number(campaign.ratePerMillion);
    if (isNaN(rate)) {
        console.error('Invalid rate per million:', campaign.ratePerMillion);
        return 0;
    }

    // Calculate earnings: (rate per million / 1,000,000) * views
    // Round to 2 decimal places to avoid floating point precision issues
    return Number(((rate / 1000000) * views).toFixed(2));
}

export async function linkTikTokAccount(tiktokUsername, linkToken) {
    try {
        // Validate inputs
        if (!tiktokUsername || !linkToken) {
            return {
                success: false,
                message: 'Both TikTok username and link token are required.'
            };
        }

        // Sanitize TikTok username
        const sanitizedUsername = sanitizeTikTokId(tiktokUsername);

        // First verify the token
        const tokenQuery = await db.collection('socialMediaAccountLinkTokens')
            .where('token', '==', linkToken)
            .limit(1)
            .get();

        if (tokenQuery.empty) {
            return {
                success: false,
                message: 'Invalid or expired token. Please generate a new token from the website.'
            };
        }

        const tokenDoc = tokenQuery.docs[0];
        const tokenData = tokenDoc.data();

        // Check if token is expired
        if (tokenData.expires_at < Date.now()) {
            await tokenDoc.ref.delete();
            return {
                success: false,
                message: 'Token has expired. Please generate a new token from the website.'
            };
        }

        // Check if token is already used
        if (tokenData.used) {
            return {
                success: false,
                message: 'This token has already been used. Please generate a new token from the website.'
            };
        }

        // Get TikTok user info
        const response = await fetch(`https://tiktok-api23.p.rapidapi.com/api/user/info?uniqueId=${sanitizedUsername}`, {
            headers: {
                'x-rapidapi-host': 'tiktok-api23.p.rapidapi.com',
                'x-rapidapi-key': process.env.RAPID_API_KEY
            }
        });
        
        const data = await response.json();
        
        if (!data.userInfo?.user?.signature) {
            throw new Error('Could not fetch TikTok bio');
        }

        const signature = data.userInfo.user.signature;
        
        // Log the user's bio and token for debugging
        console.log('Verification Check:', {
            bio: signature,
            token: linkToken,
            userId: tokenData.userId,
            bioContainsToken: signature.toLowerCase().includes(linkToken.toLowerCase())
        });
        
        // Check if the bio contains the token (case insensitive)
        if (!signature.toLowerCase().includes(linkToken.toLowerCase())) {
            return {
                success: false,
                message: 'Your TikTok bio does not contain your verification code. Please add your unique ID to your bio and try again.'
            };
        }

        // Verify we have a valid user ID, fallback to doc ID if missing
        let userId = tokenData.userId;
        if (!userId) {
            userId = tokenDoc.id;
            console.warn('Token data missing userId field, falling back to document ID:', userId);
        }
        if (!userId) {
            console.error('No userId found in token data or document ID:', tokenData, tokenDoc.id);
            return {
                success: false,
                message: 'Invalid token data. Please generate a new token from the website.'
            };
        }

        // Prepare TikTok data to store
        const tiktokData = {
            uniqueId: data.userInfo.user.uniqueId,
            profileImage: data.userInfo.user.avatarThumb,
            title: data.shareMeta.title,
            description: data.shareMeta.desc
        };

        // Update user document
        await db.collection('users').doc(userId).update({
            tiktokVerified: true,
            tiktokData: tiktokData,
            updatedAt: Date.now()
        });

        // Mark token as used
        await tokenDoc.ref.update({
            used: true
        });

        return {
            success: true,
            message: 'Success! Your account has been verified',
            data: tiktokData
        };

    } catch (error) {
        console.error('Error linking TikTok account:', error);
        return {
            success: false,
            message: 'Failed to verify TikTok account. Please try again later.',
            error: error.message
        };
    }
}

// Export sanitization functions for use in other files
export {
    sanitizeDiscordId,
    sanitizeToken,
    sanitizeUrl,
    sanitizeCampaignId,
    sanitizeTikTokId    
}; 
