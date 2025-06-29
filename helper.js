import { db, auth } from './firebaseAdmin.js';
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

function sanitizeUserId(userId) {
    if (!userId || typeof userId !== 'string') {
        throw new Error('Invalid user ID');
    }
    // Firebase Auth user IDs are 28 characters long and can contain letters, numbers, and some special characters
    if (!/^[a-zA-Z0-9_-]{1,28}$/.test(userId)) {
        throw new Error('Invalid user ID format');
    }
    return userId;
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
export async function isDiscordUserAuthenticated(discordId) {
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

// Add delays between API calls
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function getTikTokVideoData(url) {
  try {
    // Check if it's a shortened URL - updated to handle /t/, vt.tiktok.com, and vm.tiktok.com formats
    if (url.includes('/t/') || url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com')) {
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

    // Extract video/photo ID from URL - updated to handle both videos and photos
    const idMatch = url.match(/\/(video|photo)\/(\d+)/);
    if (!idMatch || !idMatch[2]) {
      throw new Error('Could not extract video/photo ID from URL: ' + url);
    }
    
    const contentType = idMatch[1]; // 'video' or 'photo'
    const contentId = idMatch[2];
    
    const response = await axios({
      method: 'GET',
      url: 'https://tiktok-api23.p.rapidapi.com/api/post/detail',
      params: { videoId: contentId },
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
    
    await delay(100); // Wait 1 second between calls

    return {
      id: contentId,
      contentType: contentType, // Add this to distinguish between videos and photos
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

// Update campaign metrics
export async function updateCampaignMetrics(campaignIds = null) {
    try {
        let campaignsSnapshot;
        
        if (campaignIds === null) {
            // If no campaignIds provided, get all campaigns
            campaignsSnapshot = await db.collection('campaigns').get();
        } else if (Array.isArray(campaignIds) && campaignIds.length > 0) {
            // If specific campaignIds provided, get only those campaigns
            campaignsSnapshot = await db.collection('campaigns')
                .where('__name__', 'in', campaignIds)
                .get();
        } else {
            throw new Error('Invalid campaignIds parameter. Must be null or a non-empty array.');
        }

        const campaigns = campaignsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const results = [];

        for (const campaign of campaigns) {
            try {
                // Skip if campaign is already marked as complete
                if (campaign.isComplete) {
                    results.push({
                        campaignId: campaign.id,
                        status: 'skipped',
                        reason: 'Campaign already complete'
                    });
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
                    results.push({
                        campaignId: campaign.id,
                        status: 'success',
                        message: 'No videos, metrics reset to 0'
                    });
                    continue;
                }

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
                    author: metricsArray[index].author || null,
                    earnings: calculateEarnings(campaign, metricsArray[index].views || 0)
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
                    views: totalMetrics.views,
                    shares: totalMetrics.shares,
                    comments: totalMetrics.comments,
                    likes: totalMetrics.likes,
                    budgetUsed,
                    isComplete: completionStatus,
                    lastUpdated: Date.now(),
                    videos: updatedVideos
                };

                // Update campaign in Firestore
                await db.collection('campaigns').doc(campaign.id).update(campaignUpdate);

                results.push({
                    campaignId: campaign.id,
                    status: 'success',
                    metrics: totalMetrics,
                    budgetUsed,
                    isComplete: completionStatus
                });

            } catch (error) {
                console.error(`Error updating metrics for campaign ${campaign.id}:`, error);
                results.push({
                    campaignId: campaign.id,
                    status: 'error',
                    error: error.message
                });
            }
        }

        return {
            success: true,
            results
        };
    } catch (error) {
        console.error('Error in updateCampaignMetrics:', error);
        throw error;
    }
}

export function calculateEarnings(campaign, views) {
    // Input validation
    if (!campaign || typeof views !== 'number' || isNaN(views)) {
        console.error('Invalid input to calculateEarnings:', { campaign, views });
        return 0;
    }

    // Ensure ratePerMillion is a valid number
    const rate = Number(campaign.ratePerMillion);
    if (isNaN(rate)) {
        console.error('Invalid rate per million:', campaign.ratePerMillion);
        return 0;
    }

    // Calculate earnings: (rate per million / 1,000,000) * views
    // Round to 2 decimal places to avoid floating point precision issues
    const amount = Number(((rate / 1000000) * views).toFixed(2));
    
    if (campaign.maxCreatorEarningsPerPost && amount > campaign.maxCreatorEarningsPerPost) {
        return campaign.maxCreatorEarningsPerPost;
    }

    return amount;
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

        // Get existing user data to preserve current tiktokData accounts
        const existingUserDoc = await db.collection('users').doc(userId).get();
        const existingUserData = existingUserDoc.exists ? existingUserDoc.data() : {};
        const currentTiktokData = existingUserData.tiktokData || {};

        // Check if this TikTok account is already linked
        const tiktokUniqueId = data.userInfo.user.uniqueId;
        if (currentTiktokData[tiktokUniqueId]) {
            return {
                success: false,
                message: 'This TikTok account is already linked to your account.'
            };
        }

        // Prepare new TikTok account data
        const newAccountData = {
            uniqueId: data.userInfo.user.uniqueId,
            profileImage: data.userInfo.user.avatarThumb,
            title: data.shareMeta.title,
            description: data.shareMeta.desc,
            verifiedAt: Date.now(),
            isVerified: true
        };

        // Add new account to existing tiktokData map
        const updatedTiktokData = {
            ...currentTiktokData,
            [tiktokUniqueId]: newAccountData
        };

        // Update user document
        await db.collection('users').doc(userId).update({
            tiktokVerified: true,
            tiktokData: updatedTiktokData,
            updatedAt: Date.now()
        });

        // Mark token as used
        await tokenDoc.ref.update({
            used: true
        });

        return {
            success: true,
            message: 'Success! Your TikTok account has been verified and added to your profile.',
            data: newAccountData,
            totalAccounts: Object.keys(updatedTiktokData).length
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

// Helper function to get user by ID
export async function getUserById(userId) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return null;
        }
        return { id: userDoc.id, ...userDoc.data() };
    } catch (error) {
        console.error('Error getting user by ID:', error);
        return null;
    }
}

// Helper function to check if user has admin role
export async function isUserAdmin(userId) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return false;
        }
        
        const userData = userDoc.data();
        return userData.roles && userData.roles.includes('admin');
    } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
    }
}

// Firebase authentication middleware
export async function authenticateUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No valid authorization header found' });
        }

        const token = authHeader.split('Bearer ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        // Verify the Firebase ID token
        const decodedToken = await auth.verifyIdToken(token);
        
        // Add the user info to the request object
        req.user = {
            uid: decodedToken.uid,
            email: decodedToken.email,
            emailVerified: decodedToken.email_verified
        };

        next();
    } catch (error) {
        console.error('Authentication error:', error);
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Helper function to verify user can access their own data
export function verifyUserAccess(req, res, next) {
    const requestedUserId = req.body.userId || req.params.userId;
    
    if (!requestedUserId) {
        return res.status(400).json({ error: 'User ID is required' });
    }

    if (requestedUserId !== req.user.uid) {
        return res.status(403).json({ error: 'Unauthorized. You can only access your own data.' });
    }

    next();
}

// Helper function to verify user has admin or owner role
export async function verifyAdminOrOwnerRole(req, res, next) {
    try {
        const userId = req.user.uid;
        const userDoc = await db.collection('users').doc(userId).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userData = userDoc.data();
        const userRoles = userData.roles || [];
        
        // Check if user has admin or owner role
        if (!userRoles.includes('admin') && !userRoles.includes('owner')) {
            return res.status(403).json({ 
                error: 'Unauthorized. Admin or owner role required for this operation.' 
            });
        }
        
        next();
    } catch (error) {
        console.error('Error verifying admin/owner role:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

// Export sanitization functions for use in other files
export {
    sanitizeDiscordId,
    sanitizeToken,
    sanitizeUrl,
    sanitizeCampaignId,
    sanitizeTikTokId,
    sanitizeUserId
};

/**
 * Validates if a URL is a legitimate TikTok URL with comprehensive security checks
 * @param {string} url - The URL to validate
 * @returns {boolean} - True if valid TikTok URL, false otherwise
 */
export function isTikTokUrl(url) {
    try {
        // Input validation
        if (!url || typeof url !== 'string') {
            return false;
        }

        // Trim whitespace and check for empty string after trimming
        const trimmedUrl = url.trim();
        if (trimmedUrl.length === 0) {
            return false;
        }

        // Check for maximum length to prevent DoS attacks
        if (trimmedUrl.length > 2048) {
            return false;
        }

        // Parse the URL to validate structure
        let parsedUrl;
        try {
            parsedUrl = new URL(trimmedUrl);
        } catch (error) {
            return false;
        }

        // Security: Only allow HTTPS and HTTP protocols
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return false;
        }

        // Security: Prevent protocol confusion attacks (e.g., javascript: URLs)
        if (parsedUrl.protocol === 'http:' && !trimmedUrl.startsWith('http://')) {
            return false;
        }
        if (parsedUrl.protocol === 'https:' && !trimmedUrl.startsWith('https://')) {
            return false;
        }

        // Security: Check for null bytes or other dangerous characters
        if (trimmedUrl.includes('\0') || trimmedUrl.includes('\u0000')) {
            return false;
        }

        // Security: Prevent CRLF injection attempts
        if (trimmedUrl.includes('\r') || trimmedUrl.includes('\n') || trimmedUrl.includes('\r\n')) {
            return false;
        }

        // Security: Check for potential SSRF attempts (internal IPs, localhost, etc.)
        const hostname = parsedUrl.hostname.toLowerCase();
        const dangerousHosts = [
            'localhost', '127.0.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1',
            '10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', 
            '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', 
            '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '192.168.'
        ];
        
        for (const dangerousHost of dangerousHosts) {
            if (hostname === dangerousHost || hostname.startsWith(dangerousHost)) {
                return false;
            }
        }

        // Security: Check for potential SSRF via IP addresses
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        if (ipRegex.test(hostname)) {
            return false;
        }

        // Define legitimate TikTok domains and their variations
        const validTikTokDomains = [
            'tiktok.com',
            'www.tiktok.com',
            'm.tiktok.com',
            'vm.tiktok.com',
            'vt.tiktok.com',
            'us.tiktok.com',
            'uk.tiktok.com',
            'ca.tiktok.com',
            'au.tiktok.com',
            'de.tiktok.com',
            'fr.tiktok.com',
            'es.tiktok.com',
            'it.tiktok.com',
            'pt.tiktok.com',
            'nl.tiktok.com',
            'pl.tiktok.com',
            'ru.tiktok.com',
            'tr.tiktok.com',
            'ar.tiktok.com',
            'br.tiktok.com',
            'mx.tiktok.com',
            'co.tiktok.com',
            'pe.tiktok.com',
            'cl.tiktok.com',
            've.tiktok.com',
            'ec.tiktok.com',
            'bo.tiktok.com',
            'py.tiktok.com',
            'uy.tiktok.com',
            'ar.tiktok.com',
            'ch.tiktok.com',
            'at.tiktok.com',
            'be.tiktok.com',
            'dk.tiktok.com',
            'fi.tiktok.com',
            'gr.tiktok.com',
            'hu.tiktok.com',
            'ie.tiktok.com',
            'il.tiktok.com',
            'jp.tiktok.com',
            'kr.tiktok.com',
            'my.tiktok.com',
            'no.tiktok.com',
            'nz.tiktok.com',
            'ph.tiktok.com',
            'sg.tiktok.com',
            'se.tiktok.com',
            'th.tiktok.com',
            'vn.tiktok.com',
            'id.tiktok.com',
            'in.tiktok.com',
            'pk.tiktok.com',
            'bd.tiktok.com',
            'lk.tiktok.com',
            'np.tiktok.com',
            'mm.tiktok.com',
            'kh.tiktok.com',
            'la.tiktok.com',
            'mn.tiktok.com',
            'kz.tiktok.com',
            'uz.tiktok.com',
            'kg.tiktok.com',
            'tj.tiktok.com',
            'tm.tiktok.com',
            'af.tiktok.com',
            'ir.tiktok.com',
            'iq.tiktok.com',
            'sa.tiktok.com',
            'ae.tiktok.com',
            'qa.tiktok.com',
            'kw.tiktok.com',
            'bh.tiktok.com',
            'om.tiktok.com',
            'jo.tiktok.com',
            'lb.tiktok.com',
            'sy.tiktok.com',
            'ps.tiktok.com',
            'eg.tiktok.com',
            'ly.tiktok.com',
            'tn.tiktok.com',
            'dz.tiktok.com',
            'ma.tiktok.com',
            'mr.tiktok.com',
            'ml.tiktok.com',
            'ne.tiktok.com',
            'td.tiktok.com',
            'sd.tiktok.com',
            'et.tiktok.com',
            'so.tiktok.com',
            'dj.tiktok.com',
            'ke.tiktok.com',
            'tz.tiktok.com',
            'ug.tiktok.com',
            'rw.tiktok.com',
            'bi.tiktok.com',
            'mw.tiktok.com',
            'zm.tiktok.com',
            'zw.tiktok.com',
            'na.tiktok.com',
            'bw.tiktok.com',
            'ls.tiktok.com',
            'sz.tiktok.com',
            'mg.tiktok.com',
            'mu.tiktok.com',
            'sc.tiktok.com',
            'km.tiktok.com',
            'yt.tiktok.com',
            're.tiktok.com',
            'mz.tiktok.com',
            'ao.tiktok.com',
            'gw.tiktok.com',
            'cv.tiktok.com',
            'gm.tiktok.com',
            'gn.tiktok.com',
            'sl.tiktok.com',
            'lr.tiktok.com',
            'ci.tiktok.com',
            'gh.tiktok.com',
            'tg.tiktok.com',
            'bj.tiktok.com',
            'ng.tiktok.com',
            'cm.tiktok.com',
            'gq.tiktok.com',
            'ga.tiktok.com',
            'cg.tiktok.com',
            'cd.tiktok.com',
            'cf.tiktok.com',
            'st.tiktok.com',
            'gq.tiktok.com',
            'ao.tiktok.com',
            'zm.tiktok.com',
            'zw.tiktok.com',
            'na.tiktok.com',
            'bw.tiktok.com',
            'ls.tiktok.com',
            'sz.tiktok.com',
            'mg.tiktok.com',
            'mu.tiktok.com',
            'sc.tiktok.com',
            'km.tiktok.com',
            'yt.tiktok.com',
            're.tiktok.com',
            'mz.tiktok.com',
            'ao.tiktok.com',
            'gw.tiktok.com',
            'cv.tiktok.com',
            'gm.tiktok.com',
            'gn.tiktok.com',
            'sl.tiktok.com',
            'lr.tiktok.com',
            'ci.tiktok.com',
            'gh.tiktok.com',
            'tg.tiktok.com',
            'bj.tiktok.com',
            'ng.tiktok.com',
            'cm.tiktok.com',
            'gq.tiktok.com',
            'ga.tiktok.com',
            'cg.tiktok.com',
            'cd.tiktok.com',
            'cf.tiktok.com',
            'st.tiktok.com'
        ];

        // Check if hostname matches any valid TikTok domain
        const isTikTokDomain = validTikTokDomains.some(domain => {
            return hostname === domain || hostname.endsWith('.' + domain);
        });

        if (!isTikTokDomain) {
            return false;
        }

        // Security: Validate path structure for TikTok URLs
        const pathname = parsedUrl.pathname.toLowerCase();
        
        // Define valid TikTok URL patterns
        const validTikTokPatterns = [
            // Video URLs
            /^\/@[a-zA-Z0-9._-]+\/video\/\d+$/,
            /^\/t\/[a-zA-Z0-9]+$/,
            /^\/video\/\d+$/,
            
            // Photo URLs
            /^\/@[a-zA-Z0-9._-]+\/photo\/\d+$/,
            /^\/photo\/\d+$/,
            
            // User profile URLs
            /^\/@[a-zA-Z0-9._-]+$/,
            /^\/user\/[a-zA-Z0-9._-]+$/,
            
            // Hashtag URLs
            /^\/tag\/[a-zA-Z0-9._-]+$/,
            /^\/hashtag\/[a-zA-Z0-9._-]+$/,
            
            // Music URLs
            /^\/music\/[a-zA-Z0-9._-]+$/,
            
            // Live URLs
            /^\/@[a-zA-Z0-9._-]+\/live$/,
            /^\/live\/[a-zA-Z0-9._-]+$/,
            
            // Collection URLs
            /^\/collection\/[a-zA-Z0-9._-]+$/,
            
            // Shortened TikTok URLs - various formats
            /^\/[a-zA-Z0-9]{8,12}\/?$/,                    // vm.tiktok.com/ZNdyJyD4G/
            /^\/[a-zA-Z0-9]{8,12}$/,                       // vm.tiktok.com/ZNdyJyD4G (no trailing slash)
            /^\/[a-zA-Z0-9]{8,12}\?.*$/,                   // vm.tiktok.com/ZNdyJyD4G?param=value
            /^\/[a-zA-Z0-9]{8,12}\/.*$/,                   // vm.tiktok.com/ZNdyJyD4G/extra
            /^\/[a-zA-Z0-9]{8,12}\?.*\/.*$/,               // vm.tiktok.com/ZNdyJyD4G?param=value/extra
            
            // Alternative shortened formats (less common but possible)
            /^\/[a-zA-Z0-9]{6,15}\/?$/,                    // Allow slightly longer/shorter codes
            /^\/[a-zA-Z0-9]{6,15}\?.*$/,                   // With query params
            /^\/[a-zA-Z0-9]{6,15}\/.*$/,                   // With extra path
            
            // Root path (for redirects)
            /^\/$/
        ];

        // Check if pathname matches any valid pattern
        const isValidPath = validTikTokPatterns.some(pattern => pattern.test(pathname));
        
        if (!isValidPath) {
            return false;
        }

        // Security: Validate query parameters (only allow safe ones)
        const safeQueryParams = [
            'lang', 'region', 'is_copy_url', 'is_from_webapp', 'sender_device', 
            'sender_web_id', 'share_app_name', 'share_link_id', 'share_method', 
            'timestamp', 'tt_from', 'u_code', 'user_id', 'webcast_id', 'msToken',
            'X-Bogus', '_signature', 'aid', 'app_name', 'channel', 'device_platform',
            'iid', 'manifest_version_code', 'resolution', 'update_version_code',
            '_d', '_r', '_svg', 'checksum', 'cover_exp', 'link_reflow_popup_iteration_sharer',
            'preview_pb', 'sec_user_id', 'share_app_id', 'share_item_id', 'share_scene',
            'sharer_language', 'social_share_type', 'source', 'ug_btm', 'ug_photo_idx',
            'utm_campaign', 'utm_medium', 'utm_source', 'from_page', 'refer', 'referer',
            'enter_from', 'enter_method', 'is_from_share', 'checksum_pl', 'mid'
        ];

        const queryParams = Array.from(parsedUrl.searchParams.keys());
        const hasUnsafeParams = queryParams.some(param => !safeQueryParams.includes(param));
        
        if (hasUnsafeParams) {
            return false;
        }

        // Security: Check for potential XSS in query parameters
        const queryString = parsedUrl.search;
        if (queryString && (
            queryString.includes('<script') || 
            queryString.includes('javascript:') || 
            queryString.includes('data:text/html') ||
            queryString.includes('vbscript:') ||
            queryString.includes('onload=') ||
            queryString.includes('onerror=') ||
            queryString.includes('onclick=')
        )) {
            return false;
        }

        // Security: Validate fragment (hash) if present
        if (parsedUrl.hash) {
            const hash = parsedUrl.hash.toLowerCase();
            if (hash.includes('<script') || 
                hash.includes('javascript:') || 
                hash.includes('data:text/html') ||
                hash.includes('vbscript:') ||
                hash.includes('onload=') ||
                hash.includes('onerror=') ||
                hash.includes('onclick=')) {
                return false;
            }
        }

        // Security: Check for URL encoding attacks
        const decodedUrl = decodeURIComponent(trimmedUrl);
        if (decodedUrl !== trimmedUrl && (
            decodedUrl.includes('<script') || 
            decodedUrl.includes('javascript:') || 
            decodedUrl.includes('data:text/html') ||
            decodedUrl.includes('vbscript:') ||
            decodedUrl.includes('onload=') ||
            decodedUrl.includes('onerror=') ||
            decodedUrl.includes('onclick=')
        )) {
            return false;
        }

        // Security: Check for double encoding attacks
        const doubleDecodedUrl = decodeURIComponent(decodeURIComponent(trimmedUrl));
        if (doubleDecodedUrl !== trimmedUrl && (
            doubleDecodedUrl.includes('<script') || 
            doubleDecodedUrl.includes('javascript:') || 
            doubleDecodedUrl.includes('data:text/html') ||
            doubleDecodedUrl.includes('vbscript:') ||
            doubleDecodedUrl.includes('onload=') ||
            doubleDecodedUrl.includes('onerror=') ||
            doubleDecodedUrl.includes('onclick=')
        )) {
            return false;
        }

        // If all checks pass, it's a valid TikTok URL
        return true;

    } catch (error) {
        // If any error occurs during validation, reject the URL
        console.error('Error validating TikTok URL:', error);
        return false;
    }
} 
